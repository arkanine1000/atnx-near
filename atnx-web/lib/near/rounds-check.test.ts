import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayRejected, type CheckedDelegate } from './relay';
import { FAUCET_HOLD_CAP, roundsAppCheck, viewPanic } from './rounds-check';
import type { NearPosition, NearRound, NearSeries, RoundsViewer } from './rounds';

const ME = 'alice.atnx.testnet';

const series: NearSeries = {
  id: 1,
  finder: 'atnx.testnet',
  reference: 'ab'.repeat(32),
  roundSecs: 60,
  settleWindowSecs: 20,
  feeBps: 100,
  finderBps: 2000,
  ante: 0n,
  paused: false,
  liveRound: 3,
  presaleRound: 4,
  finderFees: 0n,
  platformFees: 0n,
};

function round(index: number, state: NearRound['state'], winner: NearRound['winner'] = null): NearRound {
  return {
    seriesId: 1,
    index,
    state,
    winner,
    presaleUp: 600n,
    presaleDown: 400n,
    mUp: 700n,
    mDown: 400n,
    nUp: 1154n,
    nDown: 1000n,
    openedAt: 0,
    closeAt: 0,
    tradeUntil: 0,
    targetE2: 100n,
    settleE2: 0n,
    paidOut: 0n,
  };
}

const pos = (over: Partial<NearPosition> = {}): NearPosition => ({
  seriesId: 1,
  roundIndex: 2,
  accountId: ME,
  presaleUp: 60n,
  presaleDown: 0n,
  stakeUp: 0n,
  stakeDown: 0n,
  sharesUp: 0n,
  sharesDown: 0n,
  ...over,
});

function viewer(over: Partial<RoundsViewer> & { balance?: bigint; rounds?: Record<number, NearRound>; positions?: Record<number, NearPosition> } = {}): RoundsViewer {
  return {
    seriesByReference: async () => series,
    series: async (id) => (id === 1 ? series : null),
    round: async (_s, i) => over.rounds?.[i] ?? null,
    position: async (_s, i) => over.positions?.[i] ?? null,
    positionsOf: async () => [],
    balanceOf: async () => over.balance ?? 100_000_000n,
    quoteBuy: async () => ({ shares: 1_000n, fee: 1n, finderFee: 0n, net: 99n }),
    nearBalance: async () => 0n,
    ...over,
  };
}

const call = (methodName: string, args: Record<string, unknown>) => ({ senderId: ME, methodName, args }) as unknown as CheckedDelegate;

async function refuses(p: Promise<void>, reason: string, detail?: string) {
  await assert.rejects(p, (e: unknown) => e instanceof RelayRejected && e.reason === reason && (detail === undefined || e.detail === detail), `${reason} ${detail ?? ''}`);
}

test('commit: the presale round, money on the account, a live series', async () => {
  const check = roundsAppCheck(viewer());
  await check(call('commit', { series_id: 1, round_index: 4, side: 'Up', amount: '25000000' }));
  await refuses(check(call('commit', { series_id: 1, round_index: 3, side: 'Up', amount: '25000000' })), 'would_fail', "round is not the series' presale round");
  await refuses(check(call('commit', { series_id: 2, round_index: 4, side: 'Up', amount: '1' })), 'would_fail', 'no such series');
  await refuses(check(call('commit', { series_id: 1, round_index: 4, side: 'Up', amount: '0' })), 'would_fail', 'amount is zero');
  await refuses(roundsAppCheck(viewer({ balance: 10n }))(call('commit', { series_id: 1, round_index: 4, side: 'Up', amount: '11' })), 'would_fail', 'balance too low');
  await refuses(check(call('commit', { series_id: 1, round_index: 4, side: 'Sideways', amount: '1' })), 'bad_args');
  await refuses(check(call('commit', { series_id: '1', round_index: 4, side: 'Up', amount: '1' })), 'bad_args');
  await refuses(check(call('commit', { series_id: 1, round_index: 4, side: 'Up', amount: 25 })), 'bad_args');
  const paused = viewer({ series: async () => ({ ...series, paused: true }) });
  await refuses(roundsAppCheck(paused)(call('commit', { series_id: 1, round_index: 4, side: 'Up', amount: '1' })), 'would_fail', 'series is paused');
});

test('buy: the quote must meet min_shares; a view panic becomes the refusal', async () => {
  const check = roundsAppCheck(viewer());
  await check(call('buy', { series_id: 1, round_index: 3, side: 'Down', amount: '100', min_shares: '990' }));
  await refuses(check(call('buy', { series_id: 1, round_index: 3, side: 'Down', amount: '100', min_shares: '1001' })), 'would_fail', 'fewer shares than the minimum you set');
  const closed = viewer({
    quoteBuy: async () => {
      throw new Error('wasm execution failed with error: FunctionCallError(ExecutionError("Smart contract panicked: trading closed for the settlement window"))');
    },
  });
  await refuses(roundsAppCheck(closed)(call('buy', { series_id: 1, round_index: 3, side: 'Up', amount: '100', min_shares: '1' })), 'would_fail', 'trading closed for the settlement window');
  const rpcDown = viewer({
    quoteBuy: async () => {
      throw new Error('fetch failed');
    },
  });
  await assert.rejects(roundsAppCheck(rpcDown)(call('buy', { series_id: 1, round_index: 3, side: 'Up', amount: '100', min_shares: '1' })), /fetch failed/);
});

test('claim and rollover', async () => {
  const settled = viewer({ rounds: { 2: round(2, 'settled', 'up'), 4: round(4, 'presale') }, positions: { 2: pos() } });
  await roundsAppCheck(settled)(call('claim', { series_id: 1, round_index: 2 }));
  await roundsAppCheck(settled)(call('claim_rollover', { series_id: 1, round_index: 2 }));
  const lost = viewer({ rounds: { 2: round(2, 'settled', 'down'), 4: round(4, 'presale') }, positions: { 2: pos() } });
  // A losing position may still be closed with claim, but there is nothing to roll.
  await roundsAppCheck(lost)(call('claim', { series_id: 1, round_index: 2 }));
  await refuses(roundsAppCheck(lost)(call('claim_rollover', { series_id: 1, round_index: 2 })), 'would_fail', 'nothing to claim');
  const live = viewer({ rounds: { 2: round(2, 'live') }, positions: { 2: pos() } });
  await refuses(roundsAppCheck(live)(call('claim', { series_id: 1, round_index: 2 })), 'would_fail', 'round is not settled');
  const none = viewer({ rounds: { 2: round(2, 'settled', 'up') } });
  await refuses(roundsAppCheck(none)(call('claim', { series_id: 1, round_index: 2 })), 'would_fail', 'no position in this round');
  const voided = viewer({ rounds: { 2: round(2, 'void'), 4: round(4, 'presale') }, positions: { 2: pos() } });
  await roundsAppCheck(voided)(call('claim', { series_id: 1, round_index: 2 }));
  await refuses(roundsAppCheck(voided)(call('claim_rollover', { series_id: 1, round_index: 2 })), 'would_fail', 'round is not settled');
});

test('faucet and withdraw', async () => {
  const check = roundsAppCheck(viewer());
  await check(call('faucet', { amount: '1000000000' }));
  await refuses(check(call('faucet', { amount: '10000000001' })), 'would_fail', 'mint above the per-call cap');
  await refuses(roundsAppCheck(viewer({ balance: FAUCET_HOLD_CAP }))(call('faucet', { amount: '1' })), 'faucet_full');
  await check(call('withdraw', { amount: '100000000' }));
  await refuses(check(call('withdraw', { amount: '100000001' })), 'would_fail', 'balance too low');
  await refuses(check(call('open_round', {})), 'method_not_allowed');
});

test('panic text is found in view errors', () => {
  assert.equal(viewPanic(new Error('... Smart contract panicked: round is not the series\' live round"))')), "round is not the series' live round");
  assert.equal(viewPanic(new Error('Smart contract panicked: balance too low')), 'balance too low');
  assert.equal(viewPanic(new Error('fetch failed')), null);
});
