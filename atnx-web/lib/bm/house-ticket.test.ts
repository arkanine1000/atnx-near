import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capLevelE2, liquidationLevelE2, maxProfitOf, payoutOf, pnlOf, quotePrices } from './house-rules';
import {
  CONTRACT_MESSAGE,
  blockLine,
  closeReasonLine,
  fmtDuration,
  fmtPriceE2,
  fundingState,
  inferRefundReason,
  limitPastE2,
  marketBlock,
  markPosition,
  maxStakeFor,
  notListedReason,
  openBlock,
  parsePriceE2,
  refundLine,
  secondsLeft,
  ticketNumbers,
  trackOutcome,
  withinLimit,
  type OpenBlock,
  type RefundReason,
  type Tracked,
} from './house-ticket';
import type { HouseClosed, HouseConfig, HouseMarket, HousePosition, HouseQuote, HouseVault } from './house-types';

const USDG = 1_000_000n;
const NOW = 1_794_300_000;

const CFG: HouseConfig = {
  owner: 'atnx.testnet',
  keeper: 'keeper.atnx.testnet',
  treasury: 'atnx.testnet',
  token: 'usdg.atnx.testnet',
  feeBps: 100,
  finderBps: 5000,
  leadMinBps: 3000,
  leadFullGapBps: 2500,
  maxOpenGapBps: 1000,
  maxProfitBps: 90000,
  minScoreE2: 10000n,
  cooloffSecs: 48 * 3600,
  marketCapBps: 200,
  utilisationCapBps: 8000,
  minStake: 10n * USDG,
  maxStake: 250n * USDG,
  maxPositionsPerAccount: 10,
  minFillDelaySecs: 5,
  orderTtlSecs: 900,
  maxQuoteAgeSecs: 900,
  emergencySecs: 86400,
  maxPositionSecs: 14 * 86400,
  lpExitDelaySecs: 86400,
  lpExitWindowSecs: 3600,
  maxStepBps: 1500,
  liqRewardBps: 100,
  faucetPerAccount: 10_000n * USDG,
  storageFloor: 0n,
  opensPaused: false,
  lpOpen: false,
};

const VAULT: HouseVault = { assets: 10_000_000n * USDG, reserved: 0n, free: 10_000_000n * USDG, margin: 0n, shares: 0n, sharePrice: '1000000', faucetPool: 0n };

function q(score: number, reading: number, o: { readAt?: number; printId?: number } = {}): HouseQuote {
  const readAt = o.readAt ?? NOW - 60;
  return { scoreE2: BigInt(Math.round(score * 100)), pushedScoreE2: null, readingE2: BigInt(Math.round(reading * 100)), printId: BigInt(o.printId ?? 1), printAt: readAt - 30, firstReadAt: readAt, lastReadAt: readAt };
}

function market(over: Partial<HouseMarket> = {}): HouseMarket {
  return { id: 1, reference: 'ab'.repeat(16), finder: null, liveSince: NOW - 5 * 86400, status: 'Open', quotes: [q(400, 404)], finalE2: null, long: null, short: null, ...over };
}

function position(over: Partial<HousePosition> = {}): HousePosition {
  return {
    id: 7n,
    account: 'alice-h.atnx.testnet',
    market: 1,
    side: 'Long',
    leverage: 3,
    stake: 100n * USDG,
    fee: USDG,
    reserved: 900n * USDG,
    state: 'Open',
    placedAt: NOW - 3600,
    limitE2: 41289n,
    entryE2: 40880n,
    openedAt: NOW - 3594,
    closeRequestedAt: null,
    closeLimitE2: null,
    ...over,
  };
}

// --------------------------------------------------------------- numbers

test('the worked example: score 400, reading 420, 3x UP of 100', () => {
  const t = ticketNumbers({ cfg: CFG, quote: q(400, 420), side: 'Long', leverage: 3, stake: 100n * USDG });
  assert.equal(t.buyE2, 40880n);
  assert.equal(t.sellE2, 40000n);
  assert.equal(t.entryE2, 40880n);
  assert.equal(fmtPriceE2(t.entryE2), '408.8');
  assert.equal(t.fee, USDG);
  assert.equal(t.cost, 101n * USDG);
  assert.equal(t.liquidationE2, 27253n);
  assert.equal(fmtPriceE2(t.liquidationE2), '272.5');
  assert.equal(t.capE2, 163520n);
  assert.equal(fmtPriceE2(t.capE2), '1,635.2');
  assert.equal(t.maxProfit, 900n * USDG);
  assert.equal(t.spreadBps, 220n);
  // Worth on fill: closing at once sells at the score, 400.
  const pnl = pnlOf('Long', 3, 100n * USDG, 40880n, 40000n);
  assert.equal(t.valueOnFill, 100n * USDG + pnl);
  assert.equal(t.valueOnFill, 93_542_074n);
  assert.ok(Math.abs(t.valueOnFillPct - -6.457926) < 1e-4);
});

test('the worked example closed later: score 480, reading 470, the sell price is the lead', () => {
  const px = quotePrices(48000n, 47000n, CFG);
  assert.equal(px.sell, 47641n);
  const pnl = pnlOf('Long', 3, 100n * USDG, 40880n, px.sell);
  assert.equal(pnl, 49_615_949n);
  assert.equal(payoutOf(100n * USDG, pnl, 900n * USDG), 149_615_949n);
});

test('levels and the maximum win, both sides and leverages', () => {
  assert.equal(liquidationLevelE2('Long', 2, 40880n), 20440n);
  assert.equal(liquidationLevelE2('Short', 3, 47641n), 63522n);
  assert.equal(liquidationLevelE2('Short', 2, 47641n), 71462n);
  assert.equal(capLevelE2('Long', 2, 100n * USDG, 40880n, 900n * USDG), 224840n);
  assert.equal(maxProfitOf('Short', 3, 250n * USDG, 90000), 750n * USDG);
  assert.equal(capLevelE2('Short', 3, 100n * USDG, 47641n, 300n * USDG), 0n);
  // A short at 3x: opens at the sell price, its win is 3x the stake at most.
  const t = ticketNumbers({ cfg: CFG, quote: q(400, 420), side: 'Short', leverage: 3, stake: 100n * USDG });
  assert.equal(t.entryE2, 40000n);
  assert.equal(t.maxProfit, 300n * USDG);
  assert.equal(t.liquidationE2, 53334n);
  // Closing at once buys back at the lead, 408.8: down 6.6 %.
  assert.equal(t.valueOnFill, 100n * USDG + pnlOf('Short', 3, 100n * USDG, 40000n, 40880n));
  assert.ok(t.valueOnFillPct < -6.5 && t.valueOnFillPct > -6.7);
});

test('value on fill: no gap costs nothing; a gap costs its distance once', () => {
  const flat = ticketNumbers({ cfg: CFG, quote: q(500, 500), side: 'Long', leverage: 2, stake: 50n * USDG });
  assert.equal(flat.valueOnFill, 50n * USDG);
  assert.equal(flat.valueOnFillPct, 0);
  assert.equal(flat.spreadBps, 0n);
  // A reading below the score moves the sell price: an UP fills at the score and is valued at the lead.
  const below = ticketNumbers({ cfg: CFG, quote: q(500, 480), side: 'Long', leverage: 2, stake: 50n * USDG });
  assert.equal(below.entryE2, 50000n);
  assert.ok(below.valueOnFill < 50n * USDG);
  // A zero price: nothing is worked out.
  const zero = ticketNumbers({ cfg: CFG, quote: q(0, 0), side: 'Long', leverage: 2, stake: 50n * USDG });
  assert.equal(zero.entryE2, 0n);
  assert.equal(zero.valueOnFill, 0n);
  assert.equal(zero.liquidationE2, 0n);
});

test('limits: 1 % past the price, the right way for each side and kind', () => {
  assert.equal(limitPastE2(40880n, 'Long', 'open'), 41289n); // 412.888 rounded up
  assert.equal(limitPastE2(40000n, 'Short', 'open'), 39600n);
  assert.equal(limitPastE2(40000n, 'Long', 'close'), 39600n);
  assert.equal(limitPastE2(40880n, 'Short', 'close'), 41289n);
  assert.equal(limitPastE2(1n, 'Short', 'open'), 1n, 'never zero');
  assert.equal(withinLimit('Long', 'open', 41289n, 41289n), true);
  assert.equal(withinLimit('Long', 'open', 41290n, 41289n), false);
  assert.equal(withinLimit('Short', 'open', 39600n, 39600n), true);
  assert.equal(withinLimit('Short', 'open', 39599n, 39600n), false);
  assert.equal(withinLimit('Long', 'close', 39599n, 39600n), false);
  assert.equal(withinLimit('Short', 'close', 41290n, 41289n), false);
});

test('maxStakeFor: the balance less the fee, within 10 to 250', () => {
  assert.equal(maxStakeFor(10_000n * USDG, CFG), 250n * USDG);
  assert.equal(maxStakeFor(101n * USDG, CFG), 100n * USDG);
  const s = maxStakeFor(100n * USDG, CFG)!;
  assert.ok(s + (s + 99n) / 100n <= 100n * USDG);
  assert.equal(s, 99_000_000n);
  assert.equal(maxStakeFor(10_100_000n, CFG), 10n * USDG);
  assert.equal(maxStakeFor(10_099_999n, CFG), null);
  assert.equal(maxStakeFor(0n, CFG), null);
});

test('prices typed and written', () => {
  assert.equal(parsePriceE2('408.8'), 40880n);
  assert.equal(parsePriceE2(' 1,635.25 '), 163525n);
  assert.equal(parsePriceE2('45'), 4500n);
  assert.equal(parsePriceE2('0'), null);
  assert.equal(parsePriceE2('4.123'), null);
  assert.equal(parsePriceE2('-1'), null);
  assert.equal(parsePriceE2('abc'), null);
  assert.equal(fmtPriceE2(4525n), '45.25');
  assert.equal(fmtPriceE2(10000n), '100.0');
});

// ------------------------------------------------------ can't order because

const okOrder = { cfg: CFG, market: market(), vault: VAULT, nowSecs: NOW, side: 'Long' as const, leverage: 3, stake: 100n * USDG, balance: 1_000n * USDG, openCount: 0 };

test('openBlock: a good order is taken', () => {
  assert.equal(openBlock(okOrder), null);
  assert.equal(openBlock({ ...okOrder, side: 'Short', leverage: 2 }), null);
});

test('openBlock: each market state', () => {
  const cases: Array<[OpenBlock, Partial<typeof okOrder>]> = [
    ['not_listed', { market: null as unknown as HouseMarket }],
    ['settled', { market: market({ status: 'Settled' }) }],
    ['close_only', { market: market({ status: 'CloseOnly' }) }],
    ['paused', { cfg: { ...CFG, opensPaused: true } }],
    ['cooloff', { market: market({ liveSince: NOW - 47 * 3600 }) }],
    ['no_quote', { market: market({ quotes: [] }) }],
    ['stale', { market: market({ quotes: [q(400, 404, { readAt: NOW - 901 })] }) }],
    ['low_score', { market: market({ quotes: [q(99.99, 99.99)] }) }],
    ['spread', { market: market({ quotes: [q(400, 460)] }) }],
  ];
  for (const [want, over] of cases) assert.equal(openBlock({ ...okOrder, ...over }), want, want);
  // A zero sell price on a DOWN with no gap.
  assert.equal(marketBlock({ cfg: CFG, market: market({ quotes: [q(0, 0)] }), nowSecs: NOW, side: 'Short' }), 'low_score');
  assert.equal(marketBlock({ cfg: { ...CFG, minScoreE2: 0n }, market: market({ quotes: [q(0, 0)] }), nowSecs: NOW, side: 'Short' }), 'zero_price');
  // At exactly the age limit, still fresh; the cool-off ends on the second.
  assert.equal(openBlock({ ...okOrder, market: market({ quotes: [q(400, 404, { readAt: NOW - 900 })] }) }), null);
  assert.equal(openBlock({ ...okOrder, market: market({ liveSince: NOW - 48 * 3600 }) }), null);
});

test('openBlock: the order, the caps and the account', () => {
  assert.equal(openBlock({ ...okOrder, leverage: 5 }), 'leverage');
  assert.equal(openBlock({ ...okOrder, stake: 10n * USDG - 1n }), 'stake_low');
  assert.equal(openBlock({ ...okOrder, stake: 250n * USDG + 1n }), 'stake_high');
  assert.equal(openBlock({ ...okOrder, openCount: 10 }), 'positions');
  assert.equal(openBlock({ ...okOrder, balance: 101n * USDG - 1n }), 'balance');
  assert.equal(openBlock({ ...okOrder, balance: 101n * USDG }), null);
  // Unknown account numbers are not held against the order.
  assert.equal(openBlock({ ...okOrder, balance: null, openCount: null }), null);
  // Market full: the side's reserve plus this one past 2 % of the vault (200,000).
  const nearlyFull = market({ long: { stake: 0n, notional: 0n, reserved: 199_200n * USDG, count: 1 } });
  assert.equal(openBlock({ ...okOrder, market: nearlyFull }), 'full', 'UP reserves 900 more');
  assert.equal(openBlock({ ...okOrder, market: nearlyFull, stake: 88n * USDG }), null, '792 still fits');
  assert.equal(openBlock({ ...okOrder, market: nearlyFull, side: 'Short' }), null, 'the other side is free');
  // The view's own side cap wins when it has one.
  assert.equal(openBlock({ ...okOrder, market: market({ sideCap: 500n * USDG }) }), 'full');
  // The vault's total: 80 % of its assets.
  assert.equal(openBlock({ ...okOrder, vault: { ...VAULT, reserved: 8_000_000n * USDG - 899n * USDG } }), 'full');
  // No vault read: not held against it (the contract refunds at the fill).
  assert.equal(openBlock({ ...okOrder, market: nearlyFull, vault: null }), null);
});

test('every refusal has the contract message and one plain line', () => {
  const all: OpenBlock[] = ['not_listed', 'settled', 'close_only', 'paused', 'cooloff', 'no_quote', 'stale', 'low_score', 'spread', 'zero_price', 'full', 'positions', 'leverage', 'stake_low', 'stake_high', 'balance'];
  for (const b of all) {
    const line = blockLine(b, { side: 'Short' });
    assert.ok(line.length > 0 && line.length < 120, b);
    assert.ok(!/undefined|null/.test(line), b);
    if (b !== 'full') assert.ok(CONTRACT_MESSAGE[b], b);
  }
  assert.equal(blockLine('full', { side: 'Short' }), 'This market is full on the DOWN side right now.');
  assert.equal(blockLine('spread'), 'The two prices are too far apart right now. Try again in a few minutes.');
  assert.match(blockLine('cooloff', { opensIn: '3 h 10 min' }), /in 3 h 10 min/);
  assert.match(blockLine('stake_low', { minStake: 10, maxStake: 250 }), /between 10 and 250 USDG/);
});

test('notListedReason: too young, too small, or not on chain yet', () => {
  const base = { nowSecs: NOW, minScoreE2: 10000n, cooloffSecs: 48 * 3600 };
  assert.equal(notListedReason({ ...base, createdAtSecs: NOW - 3600, score: 900 }), 'cooloff');
  assert.equal(notListedReason({ ...base, createdAtSecs: NOW - 5 * 86400, score: 99.4 }), 'low_score');
  assert.equal(notListedReason({ ...base, createdAtSecs: NOW - 5 * 86400, score: 100 }), 'not_listed');
  assert.equal(notListedReason({ ...base, createdAtSecs: null, score: 300 }), 'not_listed');
  // Young and under the minimum: the score is what keeps it out.
  assert.equal(notListedReason({ ...base, createdAtSecs: NOW - 3600, score: 2 }), 'low_score');
});

test('fundingState: enough, the faucet, or the faucet used up', () => {
  assert.equal(fundingState({ balance: 10n * USDG + 100_000n, claimed: 0n, cfg: CFG }), 'ok');
  assert.equal(fundingState({ balance: 10n * USDG, claimed: 0n, cfg: CFG }), 'faucet');
  assert.equal(fundingState({ balance: 0n, claimed: null, cfg: CFG }), 'faucet');
  assert.equal(fundingState({ balance: 5n * USDG, claimed: 10_000n * USDG, cfg: CFG }), 'used_up');
});

// -------------------------------------------------------------- holding

test('markPosition: valued at the price it would close at', () => {
  const p = position();
  const m = markPosition(p, market({ quotes: [q(480, 470)] }), CFG)!;
  assert.equal(m.closeE2, 47641n);
  assert.equal(m.value, 149_615_949n);
  assert.equal(m.pnl, 49_615_949n);
  assert.ok(Math.abs(m.pnlPct - 49.615949) < 1e-6);
  assert.equal(m.liquidationE2, 27253n);
  assert.equal(m.capE2, 163520n);
  assert.equal(m.atRisk, false);
  // A DOWN closes at the buy price.
  const s = markPosition(position({ side: 'Short', entryE2: 40000n, reserved: 300n * USDG }), market({ quotes: [q(400, 420)] }), CFG)!;
  assert.equal(s.closeE2, 40880n);
  // Pending, or no price: nothing to show yet.
  assert.equal(markPosition(position({ state: 'Pending', entryE2: null }), market(), CFG), null);
  assert.equal(markPosition(p, market({ quotes: [] }), CFG), null);
  // A settled market: the final price.
  assert.equal(markPosition(p, market({ status: 'Settled', finalE2: 40880n, quotes: [] }), CFG)!.value, 100n * USDG);
});

test('markPosition: "at risk" when worth nothing but not liquidated', () => {
  const p = position();
  // The reading fell to 250 while the score is 400: the sell price is 250, under the liquidation
  // level of 272.53, so the position is worth nothing; the buy price is still the score, 400.
  const risky = markPosition(p, market({ quotes: [q(400, 250)] }), CFG)!;
  assert.equal(risky.value, 0n);
  assert.equal(risky.atRisk, true);
  // Both prices at the level: liquidated, not "at risk".
  const gone = markPosition(p, market({ quotes: [q(272, 272)] }), CFG)!;
  assert.equal(gone.value, 0n);
  assert.equal(gone.atRisk, false);
});

test('secondsLeft: the 14 days from the fill, or the view\'s end', () => {
  assert.equal(secondsLeft(position(), CFG, NOW), 14 * 86400 - 3594);
  assert.equal(secondsLeft(position({ expiresAt: NOW + 60 }), CFG, NOW), 60);
  assert.equal(secondsLeft(position({ expiresAt: NOW - 60 }), CFG, NOW), 0);
  assert.equal(secondsLeft(position({ openedAt: null, state: 'Pending' }), CFG, NOW), null);
  assert.equal(fmtDuration(3 * 86400 + 4 * 3600 + 5), '3 d 4 h');
  assert.equal(fmtDuration(5 * 3600 + 12 * 60), '5 h 12 min');
  assert.equal(fmtDuration(30), '1 min');
});

// ------------------------------------------------------------ after the tap

const closed = (id: bigint, reason = 'close'): HouseClosed => ({ id, market: 1, side: 'Long', leverage: 3, stake: 100n * USDG, entryE2: 40880n, exitE2: 40000n, payout: 93n * USDG, reason, openedAt: NOW - 100, closedAt: NOW });

test('trackOutcome: an order confirms, fills, or is refunded', () => {
  const pending = position({ state: 'Pending', entryE2: null, openedAt: null, placedAt: NOW - 10 });
  const t: Tracked = { id: 7n, kind: 'open', sentAtMs: (NOW - 10) * 1000, last: pending };
  const at = (secs: number) => (NOW + secs) * 1000;
  assert.deepEqual(trackOutcome(t, { position: pending, history: [], market: market() }, CFG, at(0)), { phase: 'waiting', slow: false, cancellable: false });
  assert.deepEqual(trackOutcome(t, { position: pending, history: [], market: market() }, CFG, at(85)), { phase: 'waiting', slow: true, cancellable: false });
  assert.deepEqual(trackOutcome(t, { position: pending, history: [], market: market() }, CFG, at(900)), { phase: 'waiting', slow: true, cancellable: true });
  assert.deepEqual(trackOutcome(t, { position: position({ id: 7n }), history: [], market: market() }, CFG, at(5)), { phase: 'filled', entryE2: 40880n });
  // Gone with a history entry: it filled and ended already.
  assert.deepEqual(trackOutcome(t, { position: null, history: [closed(7n, 'liquidation')], market: market() }, CFG, at(30)), { phase: 'closed', closed: closed(7n, 'liquidation') });
  // Gone without one: refunded.
  assert.equal(trackOutcome(t, { position: null, history: [closed(6n)], market: market() }, CFG, at(30)).phase, 'refunded');
  assert.deepEqual(trackOutcome({ ...t, kind: 'cancel' }, { position: null, history: [], market: market() }, CFG, at(950)), { phase: 'refunded', reason: 'cancelled' });
  // Not seen yet right after the tap: the read may lag; after 20 seconds it counts as refunded.
  const unseen: Tracked = { id: 9n, kind: 'open', sentAtMs: NOW * 1000, last: null };
  assert.equal(trackOutcome(unseen, { position: null, history: [], market: market() }, CFG, (NOW + 3) * 1000).phase, 'waiting');
  assert.deepEqual(trackOutcome(unseen, { position: null, history: [], market: market() }, CFG, (NOW + 21) * 1000), { phase: 'refunded', reason: null });
});

test('trackOutcome: a close settles, or misses its limit and goes back to Open', () => {
  const t: Tracked = { id: 7n, kind: 'close', sentAtMs: NOW * 1000, last: position({ state: 'Closing' }) };
  const closing = position({ state: 'Closing', closeRequestedAt: NOW });
  assert.equal(trackOutcome(t, { position: closing, history: [], market: market() }, CFG, (NOW + 3) * 1000).phase, 'waiting');
  // The read right after the tap can still show it Open: not missed yet.
  assert.equal(trackOutcome(t, { position: position(), history: [], market: market() }, CFG, (NOW + 2) * 1000).phase, 'waiting');
  assert.deepEqual(trackOutcome({ ...t, sawClosing: true }, { position: position(), history: [], market: market() }, CFG, (NOW + 8) * 1000), { phase: 'close_missed' });
  assert.deepEqual(trackOutcome(t, { position: position(), history: [], market: market() }, CFG, (NOW + 21) * 1000), { phase: 'close_missed' });
  assert.deepEqual(trackOutcome(t, { position: null, history: [closed(7n)], market: market() }, CFG, (NOW + 8) * 1000), { phase: 'closed', closed: closed(7n) });
  // Gone, the history not read since: still closing for a minute, then closed.
  assert.equal(trackOutcome(t, { position: null, history: [], market: market() }, CFG, (NOW + 8) * 1000).phase, 'waiting');
  assert.deepEqual(trackOutcome(t, { position: null, history: [], market: market() }, CFG, (NOW + 61) * 1000), { phase: 'closed', closed: null });
});

test('inferRefundReason: from the quote the order was due to fill at', () => {
  const order = { side: 'Long' as const, leverage: 3, stake: 100n * USDG, limitE2: 40500n, placedAt: NOW - 20 };
  const after = (score: number, reading: number) => market({ quotes: [q(score, reading, { readAt: NOW - 10, printId: 2 })] });
  const cases: Array<[RefundReason | null, HouseMarket | null, number?]> = [
    ['limit', after(400, 420)], // fills at 408.8, past 405
    ['limit', after(400, 460)], // the limit is checked before the two prices
    ['score', after(99, 99)],
    ['zero_price', after(0, 0)],
    ['full', after(400, 400)], // every other check passes at 400
    ['market_closed', market({ status: 'CloseOnly' })],
    ['market_closed', null],
    [null, market({ quotes: [q(400, 400, { readAt: NOW - 30 })] })], // no quote read after it: the ring does not say
    ['expired', market({ quotes: [q(400, 400, { readAt: NOW - 30 })] }), NOW + 900],
  ];
  for (const [want, m, now] of cases) assert.equal(inferRefundReason(order, m, CFG, now ?? NOW), want, String(want));
  // With room in the limit, the two prices too far apart.
  assert.equal(inferRefundReason({ ...order, limitE2: 50000n }, after(400, 460), CFG, NOW), 'spread');
  for (const r of ['limit', 'spread', 'full', 'score', 'zero_price', 'market_closed', 'expired', 'cancelled', null] as const) {
    assert.match(refundLine(r), /back in your balance/);
  }
  assert.match(refundLine('limit'), /price moved past your limit/);
  assert.equal(closeReasonLine('cap'), 'Hit the 10x cap');
  assert.equal(closeReasonLine('expiry'), 'Ended after 14 days');
});
