import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crankArgs,
  decodeConfig,
  decodeMarket,
  decodeMarketId,
  decodePosition,
  decodePushQuotesArgs,
  decodePushResult,
  decodeQuotesPushed,
  decodeVault,
  encU64,
  houseEventsOf,
  listArgs,
  listMarketArgs,
  positionArgs,
  pushQuotesArgs,
  pushResultOf,
  referenceToUuid,
  setMarketArgs,
  settleStaleArgs,
  uuidToReference,
} from './house-types';

// The shapes the keeper sends and reads, pinned so a change on either side
// shows here first.

const UUID = '46a8890c-25ce-4231-9112-fc1b3ba8ac07';
const REF = '46a8890c25ce42319112fc1b3ba8ac07';
const HASH = 'ab'.repeat(32);

test('references: the uuid without dashes, and back', () => {
  assert.equal(uuidToReference(UUID), REF);
  assert.equal(uuidToReference(UUID.toUpperCase()), REF);
  assert.equal(referenceToUuid(REF), UUID);
  assert.throws(() => uuidToReference('46a8890c25ce42319112fc1b3ba8ac07'), /not a market uuid/);
  assert.throws(() => referenceToUuid(UUID), /not a market reference/);
  assert.throws(() => referenceToUuid(REF.toUpperCase()), /not a market reference/);
});

test('push_quotes args: u32 market, every u64 a decimal string, the commitment', () => {
  const args = pushQuotesArgs([{ market: 3, scoreE2: 45551n, readingE2: 51300n, printId: 905n, printAt: 1_794_265_541, readAt: 1_794_265_600 }], HASH);
  assert.deepEqual(args, {
    quotes: [{ market: 3, score_e2: '45551', reading_e2: '51300', print_id: '905', print_at: '1794265541', read_at: '1794265600' }],
    commitment: HASH,
  });
  assert.throws(() => pushQuotesArgs([], 'nothex'), /64 lowercase hex/);
  // And back, as the verifier reads them from a transaction.
  assert.deepEqual(decodePushQuotesArgs(JSON.parse(JSON.stringify(args))).quotes[0], {
    market: 3,
    scoreE2: 45551n,
    readingE2: 51300n,
    printId: 905n,
    printAt: 1_794_265_541,
    readAt: 1_794_265_600,
  });
});

test('the other keeper calls and the view arguments', () => {
  assert.deepEqual(crankArgs([1n, 20n]), { position_ids: ['1', '20'] });
  // crank acts on at most 20 ids; the client never sends more.
  assert.equal((crankArgs(Array.from({ length: 20 }, (_, i) => BigInt(i))).position_ids as string[]).length, 20);
  assert.throws(() => crankArgs(Array.from({ length: 21 }, (_, i) => BigInt(i))), /at most 20 ids/);
  assert.deepEqual(listMarketArgs({ reference: REF, finder: null, liveSince: 1_794_000_000 }), { reference: REF, finder: null, live_since: '1794000000' });
  assert.deepEqual(listMarketArgs({ reference: REF, finder: 'alice-h.atnx.testnet', liveSince: 1 }).finder, 'alice-h.atnx.testnet');
  assert.throws(() => listMarketArgs({ reference: UUID, finder: null, liveSince: 1 }), /32 lowercase hex/);
  assert.deepEqual(setMarketArgs({ market: 4, status: 'CloseOnly' }), { market: 4, status: 'CloseOnly' });
  assert.deepEqual(settleStaleArgs(4), { market: 4 });
  assert.deepEqual(listArgs(100, 100), { from: 100, limit: 100 });
  assert.deepEqual(positionArgs(12n), { id: '12' });
  assert.throws(() => encU64(-1), /not a u64/);
  assert.throws(() => encU64(1.5), /not a u64/);
  assert.equal(encU64((1n << 64n) - 1n), '18446744073709551615');
});

const CONFIG = {
  owner: 'atnx.testnet',
  keeper: 'keeper.atnx.testnet',
  treasury: 'atnx.testnet',
  token: 'usdg.atnx.testnet',
  fee_bps: 100,
  finder_bps: 5000,
  lead_min_bps: 3000,
  lead_full_gap_bps: 2500,
  max_open_gap_bps: 1000,
  max_profit_bps: 90000,
  min_score_e2: '10000',
  cooloff_secs: 172800,
  market_cap_bps: 200,
  utilisation_cap_bps: 8000,
  min_stake: '10000000',
  max_stake: '250000000',
  max_positions_per_account: 10,
  min_fill_delay_secs: 3,
  order_ttl_secs: '900',
  max_quote_age_secs: 900,
  emergency_secs: 86400,
  max_position_secs: 1209600,
  lp_exit_delay_secs: 86400,
  lp_exit_window_secs: 3600,
  max_step_bps: 1500,
  liq_reward_bps: 100,
  faucet_per_account: '10000000000',
  storage_floor: '3000000000000000000000000',
  opens_paused: false,
  lp_open: false,
};

test('decodeConfig: u64s as numbers or strings; what the keeper needs is required', () => {
  const c = decodeConfig(CONFIG);
  assert.equal(c.keeper, 'keeper.atnx.testnet');
  assert.equal(c.minScoreE2, 10000n);
  assert.equal(c.orderTtlSecs, 900);
  assert.equal(c.storageFloor, 3_000_000_000_000_000_000_000_000n);
  assert.equal(c.maxStepBps, 1500);
  const { lead_min_bps: _dropped, ...noLead } = CONFIG;
  void _dropped;
  assert.throws(() => decodeConfig(noLead), /config\.lead_min_bps/);
  const { owner: _o, lp_open: _l, ...lean } = CONFIG;
  void _o;
  void _l;
  assert.equal(decodeConfig(lean).owner, null);
});

test('decodeVault: assets, reserved, free, margin, shares, share_price and faucet_pool', () => {
  const raw = { assets: '10', reserved: '2', free: '8', margin: '3', shares: '10', share_price: '1000000', faucet_pool: '5' };
  assert.deepEqual(decodeVault(raw), { assets: 10n, reserved: 2n, free: 8n, margin: 3n, shares: 10n, sharePrice: '1000000', faucetPool: 5n });
  const { faucet_pool: _f, ...noPool } = raw;
  void _f;
  assert.throws(() => decodeVault(noPool), /vault\.faucet_pool/);
});

const QUOTE = (printId: number, lastReadAt = 1_794_265_600) => ({
  score_e2: '45551',
  pushed_score_e2: '47000',
  reading_e2: 51300,
  print_id: String(printId),
  print_at: 1_794_265_541,
  first_read_at: 1_794_265_590,
  last_read_at: lastReadAt,
});

test('decodeMarket: the ring sorted by print id whatever its order; books and final are optional', () => {
  const m = decodeMarket({
    id: 0,
    reference: REF,
    finder: null,
    live_since: '1794000000',
    status: 'CloseOnly',
    quotes: [QUOTE(905), QUOTE(901), QUOTE(903)],
    final_e2: null,
    long: { stake: '0', notional: '0', reserved: '0', count: 0 },
  });
  assert.equal(m.id, 0);
  assert.equal(m.status, 'CloseOnly');
  assert.deepEqual(
    m.quotes.map((q) => q.printId),
    [901n, 903n, 905n]
  );
  assert.equal(m.quotes[0].scoreE2, 45551n);
  assert.equal(m.quotes[0].pushedScoreE2, 47000n);
  // A view without pushed_score_e2 reads as null (planQuote then uses score_e2).
  const { pushed_score_e2: _p, ...older } = QUOTE(1);
  void _p;
  assert.equal(decodeMarket({ id: 1, reference: REF, live_since: 1, status: 'Open', quotes: [older] }).quotes[0].pushedScoreE2, null);
  assert.equal(m.long?.count, 0);
  assert.equal(m.short, null);
  assert.throws(() => decodeMarket({ id: 0, reference: UUID, live_since: 1, status: 'Open', quotes: [] }), /reference/);
  assert.throws(() => decodeMarket({ id: 0, reference: REF, live_since: 1, status: 'Closed', quotes: [] }), /status/);
});

test('decodePosition: ids as U64, options as null', () => {
  const raw = {
    id: '12',
    account: 'alice-h.atnx.testnet',
    market: 3,
    side: 'Long',
    leverage: 3,
    stake: '100000000',
    fee: '1000000',
    reserved: '0',
    state: 'Pending',
    placed_at: 1_794_265_500,
    limit_e2: '46000',
    entry_e2: null,
    opened_at: null,
    close_requested_at: null,
    close_limit_e2: null,
  };
  const p = decodePosition(raw);
  assert.equal(p.id, 12n);
  assert.equal(p.side, 'Long');
  assert.equal(p.entryE2, null);
  assert.equal(p.limitE2, 46000n);
  assert.throws(() => decodePosition({ ...raw, side: 'Up' }), /side/);
  assert.equal(decodePosition({ ...raw, state: 'Open', entry_e2: 46012, opened_at: '1794265510' }).entryE2, 46012n);
});

test('decodeMarketId: a u32', () => {
  assert.equal(decodeMarketId(7), 7);
  assert.throws(() => decodeMarketId('7'), /u32/);
});

const PUSHED = { count: '3', accepted: '2', skipped: '1', first_print_id: '901', last_print_id: '905', commitment: HASH };

test('houseEventsOf: the contract events in a receipt, quotes_pushed decoded with its counts', () => {
  const logs = [
    'some other log',
    `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{}] })}`,
    `EVENT_JSON:${JSON.stringify({ standard: 'atnx_house', version: '1.0.0', event: 'quotes_pushed', data: [PUSHED] })}`,
    'EVENT_JSON:{not json',
  ];
  const events = houseEventsOf(logs);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'quotes_pushed');
  const ev = decodeQuotesPushed(events[0]);
  assert.deepEqual(ev, { count: 3, accepted: 2, skipped: 1, firstPrintId: '901', lastPrintId: '905', commitment: HASH });
  assert.deepEqual(pushResultOf(ev), ev);
  // Without the counts there is no result.
  assert.equal(pushResultOf(decodeQuotesPushed({ event: 'quotes_pushed', version: null, data: [{ commitment: HASH }] })), null);
});

test('decodePushResult: push_quotes returns the same fields as its event', () => {
  assert.deepEqual(decodePushResult(PUSHED), { count: 3, accepted: 2, skipped: 1, firstPrintId: '901', lastPrintId: '905', commitment: HASH });
  assert.throws(() => decodePushResult({ count: '3' }), /count, accepted and skipped/);
  assert.throws(() => decodePushResult(undefined), /expected an object/);
});
