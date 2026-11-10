import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRANK_BATCH,
  applyQuotes,
  capDue,
  chainByReference,
  chunk,
  closeOnlyPlan,
  dueAction,
  finderFor,
  healthGate,
  liquidationDue,
  listingPlan,
  missingSlot,
  planQuote,
  quotePrices,
  readAtOf,
  stalePlan,
  type AtnxMarketRow,
} from './house-rules';
import type { HouseConfig, HouseMarket, HousePosition, HouseQuote, QuoteIn } from './house-types';

const T = 1_794_265_500; // 2026-11-09 23:05:00 UTC, a slot boundary
const UUID = '46a8890c-25ce-4231-9112-fc1b3ba8ac07';
const REF = UUID.replace(/-/g, '');

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
  minStake: 10_000_000n,
  maxStake: 250_000_000n,
  maxPositionsPerAccount: 10,
  minFillDelaySecs: 3,
  orderTtlSecs: 900,
  maxQuoteAgeSecs: 900,
  minQuoteGapSecs: 240,
  emergencySecs: 86400,
  maxPositionSecs: 14 * 86400,
  lpExitDelaySecs: 86400,
  lpExitWindowSecs: 3600,
  maxStepBps: 1500,
  liqRewardBps: 100,
  faucetPerAccount: 10_000_000_000n,
  storageFloor: 0n,
  opensPaused: false,
  lpOpen: false,
};

function quote(score: number, reading: number, printId: number, readAt: number, firstReadAt = readAt): HouseQuote {
  return { scoreE2: BigInt(Math.round(score * 100)), readingE2: BigInt(Math.round(reading * 100)), printId: BigInt(printId), printAt: readAt - 60, firstReadAt, lastReadAt: readAt };
}

function market(quotes: HouseQuote[], over: Partial<HouseMarket> = {}): HouseMarket {
  return { id: 1, reference: REF, finder: null, liveSince: T - 5 * 86400, status: 'Open', quotes, finalE2: null, long: null, short: null, ...over };
}

function position(over: Partial<HousePosition>): HousePosition {
  return {
    id: 1n,
    account: 'alice-h.atnx.testnet',
    market: 1,
    side: 'Long',
    leverage: 3,
    stake: 100_000_000n,
    fee: 1_000_000n,
    reserved: 0n,
    state: 'Open',
    placedAt: T - 3600,
    limitE2: 50000n,
    entryE2: 40880n,
    openedAt: T - 3600,
    closeRequestedAt: null,
    closeLimitE2: null,
    ...over,
  };
}

// ------------------------------------------------------------ the prices

test('quotePrices: the worked example (score 400, reading 420; then 480 and 470)', () => {
  const a = quotePrices(40000n, 42000n, CFG);
  // gap 5 %, lambda 0.44, lead 408.8: buy at the lead, sell at the score.
  assert.deepEqual(a, { lead: 40880n, buy: 40880n, sell: 40000n });
  const b = quotePrices(48000n, 47000n, CFG);
  // gap 2.08 %, lambda 0.358, lead 476.42: sell at the lead, buy at the score.
  assert.deepEqual(b, { lead: 47642n, buy: 48000n, sell: 47642n });
});

test('quotePrices: no gap, a gap past the full one, a zero score', () => {
  assert.deepEqual(quotePrices(50000n, 50000n, CFG), { lead: 50000n, buy: 50000n, sell: 50000n });
  // 40 % above: lambda capped at 1, the lead is the reading.
  assert.deepEqual(quotePrices(50000n, 70000n, CFG), { lead: 70000n, buy: 70000n, sell: 50000n });
  assert.deepEqual(quotePrices(0n, 100n, CFG), { lead: 100n, buy: 100n, sell: 0n });
  // lambda = 1 for every gap (lead_min = 100 %).
  assert.deepEqual(quotePrices(40000n, 42000n, { leadMinBps: 10000, leadFullGapBps: 2500 }).lead, 42000n);
});

// ------------------------------------------------------------ crank rules

test('rule 1: a pending order fills once a quote was read min_fill_delay_secs after it', () => {
  const p = position({ state: 'Pending', placedAt: T, entryE2: null, openedAt: null });
  assert.equal(dueAction(p, market([quote(400, 400, 10, T + 2)]), CFG, T + 2), null);
  assert.equal(dueAction(p, market([quote(400, 400, 10, T + 3)]), CFG, T + 3), 'fill');
  // A print read before the order and again after it counts.
  assert.equal(dueAction(p, market([quote(400, 400, 10, T + 60, T - 200)]), CFG, T + 60), 'fill');
});

test('rule 2: a pending order with no quote after it is refunded after order_ttl_secs', () => {
  const p = position({ state: 'Pending', placedAt: T, entryE2: null, openedAt: null });
  const m = market([quote(400, 400, 10, T - 10)]);
  assert.equal(dueAction(p, m, CFG, T + CFG.orderTtlSecs - 1), null);
  assert.equal(dueAction(p, m, CFG, T + CFG.orderTtlSecs), 'refund');
});

test('rule 3: liquidation when the buy price (long) or the sell price (short) reaches the level', () => {
  // 3x long at 408.80: level 272.53. Both prices must be there.
  const long = position({ entryE2: 40880n });
  assert.equal(dueAction(long, market([quote(300, 300, 10, T)]), CFG, T), null);
  assert.equal(dueAction(long, market([quote(272, 272, 10, T)]), CFG, T), 'liquidate');
  // The reading alone at the level does not liquidate (the lead is above it).
  assert.equal(dueAction(long, market([quote(300, 200, 10, T)]), CFG, T), null);
  // 3x short at 400: level 533.33.
  const short = position({ side: 'Short', entryE2: 40000n });
  assert.equal(dueAction(short, market([quote(520, 520, 10, T)]), CFG, T), null);
  assert.equal(dueAction(short, market([quote(534, 534, 10, T)]), CFG, T), 'liquidate');
  // 2x long at 400: level 200.
  assert.equal(dueAction(position({ leverage: 2, entryE2: 40000n }), market([quote(200, 200, 10, T)]), CFG, T), 'liquidate');
});

test('rule 3: within the tolerance of the level is sent, the contract decides', () => {
  const long = position({ entryE2: 40000n }); // level 266.67
  const just = quote(267.2, 267.2, 10, T); // 0.2 % above the level
  assert.equal(liquidationDue(long, just, CFG, 0n), false);
  assert.equal(liquidationDue(long, just, CFG), true);
});

test('rule 4: a long closes at the cap at four times entry (3x), 5.5 times (2x)', () => {
  const long3 = position({ entryE2: 40000n });
  assert.equal(dueAction(long3, market([quote(1500, 1500, 10, T)]), CFG, T), null);
  assert.equal(dueAction(long3, market([quote(1600, 1600, 10, T)]), CFG, T), 'cap');
  const long2 = position({ leverage: 2, entryE2: 40000n });
  assert.equal(capDue(long2, quote(2100, 2100, 10, T), CFG), false);
  assert.equal(capDue(long2, quote(2200, 2200, 10, T), CFG), true);
  // A short's cap is the score at zero.
  const short = position({ side: 'Short', entryE2: 40000n });
  assert.equal(capDue(short, quote(1, 1, 10, T), CFG), false);
  assert.equal(capDue(short, quote(0, 0, 10, T), CFG), true);
});

test('rule 5: a close settles once a quote was read after the request', () => {
  const p = position({ state: 'Closing', closeRequestedAt: T, closeLimitE2: 40000n });
  assert.equal(dueAction(p, market([quote(410, 410, 10, T + 1)]), CFG, T + 1), null);
  assert.equal(dueAction(p, market([quote(410, 410, 10, T + 3)]), CFG, T + 3), 'close');
  // Liquidation comes first.
  assert.equal(dueAction(p, market([quote(250, 250, 10, T + 1)]), CFG, T + 1), 'liquidate');
});

test('rule 6: an open position expires after max_position_secs', () => {
  const p = position({ openedAt: T });
  const m = market([quote(410, 410, 10, T + 60)]);
  assert.equal(dueAction(p, m, CFG, T + CFG.maxPositionSecs - 1), null);
  assert.equal(dueAction(p, m, CFG, T + CFG.maxPositionSecs), 'expire');
});

test('rule 7: on a settled market, open and closing positions close and orders are refunded', () => {
  const m = market([quote(410, 410, 10, T)], { status: 'Settled', finalE2: 41000n });
  assert.equal(dueAction(position({}), m, CFG, T), 'settled');
  assert.equal(dueAction(position({ state: 'Closing', closeRequestedAt: T }), m, CFG, T), 'settled');
  assert.equal(dueAction(position({ state: 'Pending', entryE2: null, openedAt: null }), m, CFG, T), 'refund');
});

test('nothing due: an ordinary open position, or an unknown market', () => {
  assert.equal(dueAction(position({}), market([quote(410, 412, 10, T)]), CFG, T), null);
  assert.equal(dueAction(position({}), undefined, CFG, T), null);
  assert.equal(dueAction(position({}), market([]), CFG, T), null);
});

test('chunk: crank batches of 20', () => {
  const ids = Array.from({ length: 45 }, (_, i) => BigInt(i + 1));
  const batches = chunk(ids, CRANK_BATCH);
  assert.equal(CRANK_BATCH, 20);
  assert.deepEqual(
    batches.map((b) => b.length),
    [20, 20, 5]
  );
  assert.deepEqual(batches.flat(), ids);
  assert.deepEqual(chunk([], 20), []);
  assert.throws(() => chunk(ids, 0), /bad size/);
});

// ------------------------------------------------------------ the reads

const row = (over: Partial<{ id: number; vi: number; raw_vi: number | null; recorded_at: string }> = {}) => ({
  id: 905,
  market_id: UUID,
  vi: 455.51,
  raw_vi: 513 as number | null,
  recorded_at: new Date((T + 45) * 1000).toISOString(),
  ...over,
});

test('healthGate: a print, with a reading, at most ten minutes old', () => {
  assert.deepEqual(healthGate({ row: row(), readAt: T + 60 }, T + 105), { ok: true });
  assert.deepEqual(healthGate({ row: null, readAt: T }, T + 105), { ok: false, reason: 'no_print' });
  assert.deepEqual(healthGate(null, T + 105), { ok: false, reason: 'no_print' });
  assert.deepEqual(healthGate({ row: row({ raw_vi: null }), readAt: T }, T + 105), { ok: false, reason: 'no_reading' });
  assert.deepEqual(healthGate({ row: row(), readAt: T }, T + 45 + 600), { ok: true });
  assert.deepEqual(healthGate({ row: row(), readAt: T }, T + 45 + 601), { ok: false, reason: 'stale' });
});

test('missingSlot: the print for the current five-minute slot', () => {
  assert.equal(missingSlot({ row: row(), readAt: T + 60 }, T + 105), false);
  // Printed in the previous slot.
  assert.equal(missingSlot({ row: row({ recorded_at: new Date((T - 255) * 1000).toISOString() }), readAt: T }, T + 105), true);
  assert.equal(missingSlot({ row: null, readAt: T }, T + 105), true);
});

test('readAtOf: the second the query started, never before the print', () => {
  assert.equal(readAtOf((T + 100) * 1000 + 999, row()), T + 100);
  // A row written while the query ran.
  assert.equal(readAtOf((T + 44) * 1000, row()), T + 45);
  assert.equal(readAtOf((T + 44) * 1000, null), T + 44);
});

// ------------------------------------------------------- planning quotes

const fresh = (over: Partial<QuoteIn> = {}): QuoteIn => ({ market: 1, scoreE2: 45551n, readingE2: 51300n, printId: 905n, printAt: T + 45, readAt: T + 105, ...over });
const stored = (over: Partial<HouseQuote> = {}): HouseQuote => ({ scoreE2: 45000n, readingE2: 50000n, printId: 900n, printAt: T - 255, firstReadAt: T - 195, lastReadAt: T - 195, ...over });

test('planQuote: a new print, the same print again, and what is left out', () => {
  assert.deepEqual(planQuote(fresh(), null, CFG), { action: 'push' });
  assert.deepEqual(planQuote(fresh(), stored(), CFG), { action: 'push' });
  // The hourly pass's second print, two minutes after the stored one.
  assert.deepEqual(planQuote(fresh({ printAt: T - 255 + 120 }), stored(), CFG), { action: 'skip', reason: 'too_soon' });
  // Unchanged print, read again later: moves the last read.
  const same = stored({ scoreE2: 45551n, readingE2: 51300n, printId: 905n, printAt: T + 45, lastReadAt: T + 50 });
  assert.deepEqual(planQuote(fresh(), same, CFG), { action: 'repush' });
  assert.deepEqual(planQuote(fresh({ readAt: T + 50 }), same, CFG), { action: 'skip', reason: 'already_read' });
  assert.deepEqual(planQuote(fresh({ scoreE2: 1n }), same, CFG), { action: 'skip', reason: 'numbers_differ' });
  assert.deepEqual(planQuote(fresh({ printId: 899n }), stored(), CFG), { action: 'skip', reason: 'older_than_chain' });
  assert.deepEqual(planQuote(fresh({ readAt: T - 200 }), stored({ lastReadAt: T - 100 }), CFG), { action: 'skip', reason: 'read_earlier' });
});

test('applyQuotes: re-reads move last_read_at; new prints append, clipped, eight kept', () => {
  const ring = Array.from({ length: 8 }, (_, i) => quote(400, 400, 100 + i, T - 3000 + i * 300));
  const m = market(ring);
  const again = applyQuotes([m], [fresh({ printId: 107n, scoreE2: 40000n, readingE2: 40000n, readAt: T + 999 })], CFG)[0];
  assert.equal(again.quotes.length, 8);
  assert.equal(again.quotes[7].lastReadAt, T + 999);
  const next = applyQuotes([m], [fresh({ printId: 200n, scoreE2: 80000n, readingE2: 80000n })], CFG)[0];
  assert.equal(next.quotes.length, 8);
  assert.equal(next.quotes[0].printId, 101n);
  // 400 → 800 is clipped to +15 %.
  assert.equal(next.quotes[7].scoreE2, 46000n);
  assert.equal(next.quotes[7].firstReadAt, T + 105);
  // Other markets untouched.
  const other = market([], { id: 2 });
  assert.equal(applyQuotes([other], [fresh()], CFG)[0], other);
});

// ------------------------------------------------------- atnx.app markets

function atnxRow(over: Partial<AtnxMarketRow> = {}): AtnxMarketRow {
  return {
    id: UUID,
    created_at: new Date((T - 3 * 86400) * 1000).toISOString(),
    created_by: 'user-1',
    current_vi: 455.51,
    vi_state: 'live',
    vi_last_updated: new Date((T + 45) * 1000).toISOString(),
    deleted_at: null,
    ...over,
  };
}

const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('listingPlan: live, not deleted, score at least the minimum, past the cool-off, fresh, not on chain', () => {
  const rows = [
    atnxRow({ id: uuidN(1) }),
    atnxRow({ id: uuidN(2), deleted_at: new Date(T * 1000).toISOString() }),
    atnxRow({ id: uuidN(3), vi_state: 'scoring' }),
    atnxRow({ id: uuidN(4), current_vi: 99.99 }),
    atnxRow({ id: uuidN(5), current_vi: 100 }),
    atnxRow({ id: uuidN(6), created_at: new Date((T + 105 - CFG.cooloffSecs + 1) * 1000).toISOString() }),
    atnxRow({ id: uuidN(7), vi_last_updated: new Date((T - 3600) * 1000).toISOString() }),
    atnxRow({ id: uuidN(8) }),
    atnxRow({ id: uuidN(9) }),
    atnxRow({ id: 'not-a-uuid' }),
  ];
  const onChain = [
    market([], { id: 0, reference: uuidN(8).replace(/-/g, ''), status: 'Open' }),
    market([], { id: 1, reference: uuidN(9).replace(/-/g, ''), status: 'Settled' }),
  ];
  const { list, skipped } = listingPlan({ atnx: rows, chainByRef: chainByReference(onChain), cfg: CFG, nowSecs: T + 105 });
  assert.deepEqual(
    list.map((c) => [c.uuid, c.relist]),
    [
      [uuidN(1), false],
      [uuidN(5), false],
      [uuidN(9), true],
    ]
  );
  assert.equal(list[0].reference, uuidN(1).replace(/-/g, ''));
  assert.equal(list[0].liveSince, T - 3 * 86400);
  assert.equal(list[0].creator, 'user-1');
  assert.deepEqual(skipped, { deleted: 1, scoring: 1, low_score: 1, cooloff: 1, stale: 1, listed: 1, bad_id: 1 });
});

test('chainByReference: the newest market per reference', () => {
  const a = market([], { id: 1, status: 'Settled' });
  const b = market([], { id: 5, status: 'Open' });
  assert.equal(chainByReference([b, a]).get(REF)?.id, 5);
});

test('finderFor: the house account of the creator\'s NEAR account, else none', () => {
  const accounts = new Map([
    ['user-1', 'alice.atnx.testnet'],
    ['user-2', 'odd.example.testnet'],
  ]);
  assert.equal(finderFor('user-1', accounts), 'alice-h.atnx.testnet');
  assert.equal(finderFor('user-2', accounts), null);
  assert.equal(finderFor('user-3', accounts), null);
  assert.equal(finderFor(null, accounts), null);
});

test('closeOnlyPlan: open markets whose atnx.app market is deleted or gone', () => {
  const m1 = market([], { id: 1, reference: uuidN(1).replace(/-/g, '') });
  const m2 = market([], { id: 2, reference: uuidN(2).replace(/-/g, '') });
  const m3 = market([], { id: 3, reference: uuidN(3).replace(/-/g, '') });
  const m4 = market([], { id: 4, reference: uuidN(4).replace(/-/g, ''), status: 'CloseOnly' });
  const atnx = new Map([
    [uuidN(1), atnxRow({ id: uuidN(1) })],
    [uuidN(2), atnxRow({ id: uuidN(2), deleted_at: new Date(T * 1000).toISOString() })],
    [uuidN(4), atnxRow({ id: uuidN(4), deleted_at: new Date(T * 1000).toISOString() })],
  ]);
  assert.deepEqual(
    closeOnlyPlan([m1, m2, m3, m4], atnx).map((m) => m.id),
    [2, 3]
  );
});

test('stalePlan: no quote read for emergency_secs (plus a margin); never-quoted and settled markets left alone', () => {
  const now = T + 200_000;
  const old = market([quote(400, 400, 10, now - CFG.emergencySecs - 60)], { id: 1 });
  const recent = market([quote(400, 400, 10, now - CFG.emergencySecs - 59)], { id: 2 });
  const never = market([], { id: 3 });
  const settled = market([quote(400, 400, 10, now - 10 * 86400)], { id: 4, status: 'Settled' });
  const closeOnly = market([quote(400, 400, 10, now - 2 * 86400)], { id: 5, status: 'CloseOnly' });
  assert.deepEqual(
    stalePlan([old, recent, never, settled, closeOnly], CFG, now).map((m) => m.id),
    [1, 5]
  );
});
