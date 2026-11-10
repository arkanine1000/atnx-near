import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HouseConfig, HouseMarket, HousePosition, HouseQuote } from '@/lib/bm/house-types';
import { houseAppCheck, onDemandPositionId, type HouseCheckViewer } from './house-check';
import { RelayRejected, type CheckedDelegate } from './relay';

const ME = 'alice-h.atnx.testnet';
const NOW = 1_794_300_000;
const USDG = 1_000_000n;

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

function q(score: number, reading: number, readAt = NOW - 60): HouseQuote {
  return { scoreE2: BigInt(Math.round(score * 100)), pushedScoreE2: null, readingE2: BigInt(Math.round(reading * 100)), printId: 1n, printAt: readAt - 30, firstReadAt: readAt, lastReadAt: readAt };
}

function market(over: Partial<HouseMarket> = {}): HouseMarket {
  return { id: 1, reference: 'ab'.repeat(16), finder: null, liveSince: NOW - 5 * 86400, status: 'Open', quotes: [q(400, 404)], finalE2: null, long: null, short: null, ...over };
}

function position(over: Partial<HousePosition> = {}): HousePosition {
  return {
    id: 7n,
    account: ME,
    market: 1,
    side: 'Long',
    leverage: 3,
    stake: 100n * USDG,
    fee: USDG,
    reserved: 900n * USDG,
    state: 'Open',
    placedAt: NOW - 3600,
    limitE2: 41300n,
    entryE2: 40880n,
    openedAt: NOW - 3590,
    closeRequestedAt: null,
    closeLimitE2: null,
    ...over,
  };
}

function viewer(o: { cfg?: Partial<HouseConfig>; markets?: Record<number, HouseMarket>; positions?: Record<string, HousePosition>; mine?: HousePosition[]; balance?: bigint; claimed?: bigint | null } = {}): HouseCheckViewer {
  return {
    config: async () => ({ ...CFG, ...o.cfg }),
    market: async (id) => (o.markets ?? { 1: market() })[id] ?? null,
    position: async (id) => (o.positions ?? {})[id.toString()] ?? null,
    positionsOf: async () => o.mine ?? [],
    balanceOf: async () => o.balance ?? 10_000n * USDG,
    faucetClaimed: async () => (o.claimed === undefined ? 0n : o.claimed),
    nowSecs: async () => NOW,
  };
}

const call = (methodName: string, args: Record<string, unknown>, senderId = ME) => ({ methodName, args, senderId }) as unknown as CheckedDelegate;
const OPEN = { market: 1, side: 'Long', leverage: 3, stake: '100000000', limit_e2: '41289' };

async function refused(p: Promise<void>, reason: string, detail?: string) {
  await assert.rejects(
    p,
    (e: unknown) => e instanceof RelayRejected && e.reason === reason && (detail === undefined || e.detail === detail),
    `expected ${reason}${detail ? `: ${detail}` : ''}`,
  );
}

test('faucet: the lifetime cap per account', async () => {
  await houseAppCheck(viewer())(call('faucet', { amount: '10000000000' }));
  await houseAppCheck(viewer({ claimed: 4_000n * USDG }))(call('faucet', { amount: '6000000000' }));
  await refused(houseAppCheck(viewer({ claimed: 4_000n * USDG }))(call('faucet', { amount: '6000000001' })), 'would_fail', 'faucet limit reached for this account');
  await refused(houseAppCheck(viewer({ claimed: 10_000n * USDG }))(call('faucet', { amount: '1' })), 'faucet_full');
  await refused(houseAppCheck(viewer())(call('faucet', { amount: '10000000001' })), 'would_fail', 'faucet limit reached for this account');
  await refused(houseAppCheck(viewer())(call('faucet', { amount: '0' })), 'would_fail', 'amount is zero');
  await refused(houseAppCheck(viewer())(call('faucet', { amount: 5 })), 'bad_args');
  // A contract with no faucet_claimed view: the per-call amount is still capped.
  await houseAppCheck(viewer({ claimed: null }))(call('faucet', { amount: '10000000000' }));
  await refused(houseAppCheck(viewer({ claimed: null }))(call('faucet', { amount: '10000000001' })), 'would_fail');
});

test('withdraw: a positive amount the balance covers', async () => {
  await houseAppCheck(viewer({ balance: 50n * USDG }))(call('withdraw', { amount: '50000000' }));
  await refused(houseAppCheck(viewer({ balance: 50n * USDG }))(call('withdraw', { amount: '50000001' })), 'would_fail', 'balance too low');
  await refused(houseAppCheck(viewer())(call('withdraw', { amount: '0' })), 'would_fail', 'amount is zero');
});

test('open: a good order passes', async () => {
  await houseAppCheck(viewer())(call('open', OPEN));
  await houseAppCheck(viewer())(call('open', { ...OPEN, side: 'Short', leverage: 2, limit_e2: '39600' }));
});

test('open: the market has to be listed, open and fresh', async () => {
  const check = (m: Partial<HouseMarket> | null, cfg: Partial<HouseConfig> = {}) =>
    houseAppCheck(viewer({ markets: m === null ? {} : { 1: market(m) }, cfg }))(call('open', OPEN));
  await refused(check(null), 'would_fail', 'no such market');
  await refused(check({ status: 'CloseOnly' }), 'would_fail', 'market is not open');
  await refused(check({ status: 'Settled' }), 'would_fail', 'market is not open');
  await refused(check({}, { opensPaused: true }), 'would_fail', 'new orders are paused');
  await refused(check({ liveSince: NOW - 47 * 3600 }), 'would_fail', 'market is inside its cool-off');
  await refused(check({ quotes: [] }), 'would_fail', 'market has no quote');
  await refused(check({ quotes: [q(400, 404, NOW - 901)] }), 'would_fail', "the market's newest quote is too old");
  await check({ quotes: [q(400, 404, NOW - 900)] });
  await refused(check({ quotes: [q(99.99, 99.99)] }), 'would_fail', 'score is under the minimum to open');
  // 400 against a reading of 460: the lead goes 15 % up, past the 10 % guard.
  await refused(check({ quotes: [q(400, 460)] }), 'would_fail', 'the two prices are too far apart');
});

test('open: leverage, stake, limit, balance, position limit', async () => {
  const v = viewer();
  await refused(houseAppCheck(v)(call('open', { ...OPEN, leverage: 5 })), 'would_fail', 'leverage must be 2 or 3');
  await refused(houseAppCheck(v)(call('open', { ...OPEN, stake: '9999999' })), 'would_fail', 'stake below the minimum');
  await refused(houseAppCheck(v)(call('open', { ...OPEN, stake: '250000001' })), 'would_fail', 'stake above the maximum');
  await houseAppCheck(v)(call('open', { ...OPEN, stake: '250000000' }));
  await refused(houseAppCheck(v)(call('open', { ...OPEN, limit_e2: '0' })), 'would_fail', 'a limit price is required');
  // stake 100 + fee 1: 100.999999 is not enough.
  await refused(houseAppCheck(viewer({ balance: 101n * USDG - 1n }))(call('open', OPEN)), 'would_fail', 'balance too low');
  await houseAppCheck(viewer({ balance: 101n * USDG }))(call('open', OPEN));
  const ten = Array.from({ length: 10 }, (_, i) => position({ id: BigInt(i) }));
  await refused(houseAppCheck(viewer({ mine: ten }))(call('open', OPEN)), 'would_fail', 'position limit reached for this account');
  await houseAppCheck(viewer({ mine: ten.slice(1) }))(call('open', OPEN));
});

test('open: malformed arguments are bad_args, before any read', async () => {
  const v = viewer();
  for (const args of [
    { ...OPEN, market: '1' },
    { ...OPEN, side: 'Up' },
    { ...OPEN, stake: 100 },
    { ...OPEN, limit_e2: 41289 },
    { ...OPEN, limit_e2: '99999999999999999999999' },
    { ...OPEN, leverage: 2.5 },
  ]) {
    await refused(houseAppCheck(v)(call('open', args)), 'bad_args');
  }
});

test('close: the signer\'s own open position, with a limit', async () => {
  const positions = { '7': position(), '8': position({ id: 8n, account: 'bob-h.atnx.testnet' }), '9': position({ id: 9n, state: 'Pending' }), '10': position({ id: 10n, state: 'Closing' }) };
  const v = viewer({ positions });
  await houseAppCheck(v)(call('close', { position_id: '7', limit_e2: '39600' }));
  await refused(houseAppCheck(v)(call('close', { position_id: '6', limit_e2: '39600' })), 'would_fail', 'no such position');
  await refused(houseAppCheck(v)(call('close', { position_id: '8', limit_e2: '39600' })), 'would_fail', 'not your position');
  await refused(houseAppCheck(v)(call('close', { position_id: '9', limit_e2: '39600' })), 'would_fail', 'position is not open');
  await refused(houseAppCheck(v)(call('close', { position_id: '10', limit_e2: '39600' })), 'would_fail', 'position is not open');
  await refused(houseAppCheck(v)(call('close', { position_id: '7', limit_e2: '0' })), 'would_fail', 'a limit price is required');
  await refused(houseAppCheck(v)(call('close', { position_id: 7, limit_e2: '39600' })), 'bad_args');
  // Past its end, the position is already closing by itself.
  const ended = viewer({ positions: { '7': position({ expiresAt: NOW - 1 }) } });
  await refused(houseAppCheck(ended)(call('close', { position_id: '7', limit_e2: '39600' })), 'would_fail', 'position has reached its end and is closing');
});

test('cancel: the signer\'s own pending order, once its time to live has passed', async () => {
  const old = position({ id: 7n, state: 'Pending', entryE2: null, openedAt: null, placedAt: NOW - 901 });
  const fresh = position({ id: 8n, state: 'Pending', entryE2: null, openedAt: null, placedAt: NOW - 30 });
  const v = viewer({ positions: { '7': old, '8': fresh, '9': position({ id: 9n }), '10': { ...old, id: 10n, account: 'bob-h.atnx.testnet' } } });
  await houseAppCheck(v)(call('cancel', { position_id: '7' }));
  await refused(houseAppCheck(v)(call('cancel', { position_id: '8' })), 'would_fail', 'an order can be cancelled only once its time to live has passed');
  await refused(houseAppCheck(v)(call('cancel', { position_id: '9' })), 'would_fail', 'order is not pending');
  await refused(houseAppCheck(v)(call('cancel', { position_id: '10' })), 'would_fail', 'not your position');
  await refused(houseAppCheck(v)(call('cancel', { position_id: '11' })), 'would_fail', 'no such position');
});

test('crank: anyone, one to 20 ids', async () => {
  const v = viewer();
  await houseAppCheck(v)(call('crank', { position_ids: ['1'] }, 'bob-h.atnx.testnet'));
  await houseAppCheck(v)(call('crank', { position_ids: Array.from({ length: 20 }, (_, i) => String(i)) }));
  await refused(houseAppCheck(v)(call('crank', { position_ids: Array.from({ length: 21 }, (_, i) => String(i)) })), 'bad_args');
  await refused(houseAppCheck(v)(call('crank', { position_ids: [] })), 'bad_args');
  await refused(houseAppCheck(v)(call('crank', { position_ids: [1] })), 'bad_args');
  await refused(houseAppCheck(v)(call('crank', {})), 'bad_args');
});

test('anything else is not allowed', async () => {
  for (const m of ['push_quotes', 'commit', 'lp_deposit', 'set_paused']) await refused(houseAppCheck(viewer())(call(m, {})), 'method_not_allowed');
});

test('onDemandPositionId: the id an open returned, or the one a close named', () => {
  assert.equal(onDemandPositionId('open', OPEN, '42'), 42n);
  assert.equal(onDemandPositionId('open', OPEN, 42), 42n);
  assert.equal(onDemandPositionId('open', OPEN, null), null);
  assert.equal(onDemandPositionId('open', OPEN, 'x'), null);
  assert.equal(onDemandPositionId('close', { position_id: '7', limit_e2: '1' }, null), 7n);
  assert.equal(onDemandPositionId('close', { position_id: 7 }, null), 7n);
  for (const m of ['faucet', 'cancel', 'crank', 'withdraw']) assert.equal(onDemandPositionId(m, { position_id: '7' }, '7'), null, m);
});
