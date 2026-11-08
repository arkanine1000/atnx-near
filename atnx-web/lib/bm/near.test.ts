import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, type Account } from 'near-api-js';
import {
  KEEPER_FLOAT,
  MAX_FAUCET,
  NEAR_ROUNDS_ERRORS,
  NearCallError,
  NearRounds,
  assertTestnet,
  faucetPlan,
  gasBurnt,
  isNearAccountId,
  nearErrorName,
  nearPanicMessage,
  outcomeBlockHashes,
  parseConfig,
  parsePosition,
  parseQuote,
  parseRound,
  parseSeries,
  parseNearSecret,
  sideFromNear,
  sideToNear,
  successValue,
  toNearCallError,
  tokensBurnt,
  txHashOf,
} from './near';

// ---------------------------------------------------------------- errors

// As testnet returned them (2026-11-08).
const VIEW_PANIC = `wasm execution failed with error: HostError(GuestPanic { panic_msg: "round is not the series' live round" })`;
const VIEW_ARGS = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "Failed to deserialize input from JSON. Error: `invalid type: string \\"x\\", expected u32 at line 1 column 16`" })';

test('nearPanicMessage: a view panic, as the RPC words it', () => {
  assert.equal(nearPanicMessage(new Error(VIEW_PANIC)), "round is not the series' live round");
  assert.equal(nearErrorName(new Error(VIEW_PANIC)), "round is not the series' live round");
});

test('nearPanicMessage: escaped quotes inside the panic text', () => {
  assert.equal(nearPanicMessage(new Error(VIEW_ARGS)), 'Failed to deserialize input from JSON. Error: `invalid type: string "x", expected u32 at line 1 column 16`');
  // Not one of the contract's own: the panic text as it came.
  assert.match(nearErrorName(new Error(VIEW_ARGS))!, /^Failed to deserialize input from JSON/);
});

test('nearPanicMessage: a transaction panic, from the message or the failure JSON', () => {
  assert.equal(nearErrorName({ message: 'Smart contract panicked: round has not reached its close' }), 'round has not reached its close');
  const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: not the keeper' } } } };
  assert.equal(nearErrorName({ message: 'Unknown', transactionResult: { status: { Failure: failure } } }), 'not the keeper');
  assert.equal(
    nearErrorName({ transactionResult: { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { status: { Failure: failure } } }] } }),
    'not the keeper'
  );
});

test('nearPanicMessage: a HostGuestPanicError, a JSON vm_error, a wrapped cause', () => {
  assert.equal(nearErrorName({ panicMessage: 'balance too low', message: 'Contract panicked: balance too low' }), 'balance too low');
  assert.equal(nearErrorName({ message: 'Contract panicked: no such series' }), 'no such series');
  assert.equal(nearErrorName(new Error('x', { cause: { message: JSON.stringify({ HostError: { GuestPanic: { panic_msg: 'nothing to claim' } } }) } })), 'nothing to claim');
  assert.equal(nearErrorName(new Error('outer', { cause: new Error(VIEW_PANIC) })), "round is not the series' live round");
});

test('nearErrorName: every contract message maps to itself', () => {
  for (const m of NEAR_ROUNDS_ERRORS) assert.equal(nearErrorName(new Error(`Smart contract panicked: ${m}`)), m);
  // A message that continues past a known one keeps the known one.
  assert.equal(nearErrorName(new Error('Smart contract panicked: balance too low (need 5)')), 'balance too low');
});

test('nearErrorName: failures that are not panics give null', () => {
  assert.equal(nearErrorName(new Error('fetch failed')), null);
  assert.equal(nearErrorName(new Error('Transaction timed out')), null);
  assert.equal(nearErrorName(null), null);
  assert.equal(nearErrorName('Exceeded the prepaid gas.'), null);
});

test('toNearCallError: the code, the tx hash and a readable message', () => {
  const err = Object.assign(new Error('Smart contract panicked: series is paused'), {
    transactionResult: { transaction: { hash: 'HASH1' }, status: { Failure: {} } },
  });
  const e = toNearCallError('commit', err);
  assert.ok(e instanceof NearCallError);
  assert.deepEqual([e.method, e.code, e.txHash, e.message], ['commit', 'series is paused', 'HASH1', 'commit: series is paused']);
  assert.equal(e.cause, err);
  const plain = toNearCallError('settle', new Error('fetch failed'));
  assert.deepEqual([plain.code, plain.txHash, plain.message], [null, null, 'settle: fetch failed']);
  assert.equal(toNearCallError('x', e), e);
});

// ------------------------------------------------------------ responses

test('txHashOf and successValue: hash and the base64 JSON return value', () => {
  const b64 = (v: string) => Buffer.from(v).toString('base64');
  assert.equal(txHashOf({ transaction: { hash: 'H' } }), 'H');
  assert.equal(txHashOf({ transaction_outcome: { id: 'I' } }), 'I');
  assert.throws(() => txHashOf({}));
  assert.equal(successValue({ status: { SuccessValue: b64('7') } }), 7);
  assert.equal(successValue({ status: { SuccessValue: b64('"990000"') } }), '990000');
  assert.equal(successValue({ status: { SuccessValue: '' } }), undefined);
  assert.equal(successValue({ status: { SuccessValue: b64('not json') } }), 'not json');
  assert.equal(successValue({ status: { Failure: {} } }), undefined);
});

test('tokensBurnt, gasBurnt and outcomeBlockHashes add up the outcomes', () => {
  const res = {
    transaction_outcome: { block_hash: 'A', outcome: { tokens_burnt: '100', gas_burnt: 10 } },
    receipts_outcome: [
      { block_hash: 'B', outcome: { tokens_burnt: '250', gas_burnt: 25 } },
      { block_hash: 'B', outcome: { tokens_burnt: '0', gas_burnt: 0 } },
      { block_hash: 'C', outcome: { tokens_burnt: '5', gas_burnt: 1 } },
    ],
  };
  assert.equal(tokensBurnt(res), 355n);
  assert.equal(gasBurnt(res), 36n);
  assert.deepEqual(outcomeBlockHashes(res), ['A', 'B', 'C']);
  assert.equal(tokensBurnt(undefined), 0n);
  assert.deepEqual(outcomeBlockHashes(null), []);
});

// ---------------------------------------------------------------- views

// get_round of series 1, round 1 on testnet after the smoke test.
const ROUND = {
  series_id: 1,
  index: 1,
  state: 'Settled',
  winner: 'Up',
  presale_up: '24750000',
  presale_down: '9900000',
  m_up: '29700000',
  m_down: '9900000',
  n_up: '40967441',
  n_down: '34650000',
  opened_at: 1794154292,
  close_at: 1794154352,
  trade_until: 1794154332,
  target_e2: 100000,
  settle_e2: 100100,
  commitment: '0'.repeat(64),
  paid_out: '39600000',
};

test('parseRound: U128 strings to bigint, states and sides to lower case', () => {
  const r = parseRound(ROUND);
  assert.deepEqual(r, {
    seriesId: 1,
    index: 1,
    state: 'settled',
    winner: 'up',
    presaleUp: 24_750_000n,
    presaleDown: 9_900_000n,
    mUp: 29_700_000n,
    mDown: 9_900_000n,
    nUp: 40_967_441n,
    nDown: 34_650_000n,
    openedAt: 1794154292,
    closeAt: 1794154352,
    tradeUntil: 1794154332,
    targetE2: 100_000n,
    settleE2: 100_100n,
    commitment: '0'.repeat(64),
    paidOut: 39_600_000n,
  });
  assert.equal(parseRound({ ...ROUND, state: 'Presale', winner: null }).winner, null);
  assert.equal(parseRound({ ...ROUND, state: 'Void' }).state, 'void');
});

test('parseRound: refuses a malformed view', () => {
  assert.throws(() => parseRound({ ...ROUND, state: 'Open' }), /state/);
  assert.throws(() => parseRound({ ...ROUND, m_up: 29700000 }), /m_up/);
  assert.throws(() => parseRound({ ...ROUND, m_up: '-1' }), /m_up/);
  assert.throws(() => parseRound({ ...ROUND, commitment: 'zz' }), /commitment/);
  assert.throws(() => parseRound({ ...ROUND, winner: 'Sideways' }), /side/);
  assert.throws(() => parseRound(null), /object/);
  const { close_at: _c, ...missing } = ROUND;
  void _c;
  assert.throws(() => parseRound(missing), /close_at/);
});

test('parseSeries, parsePosition, parseQuote, parseConfig', () => {
  const s = parseSeries({
    id: 1,
    finder: 'atnx.testnet',
    reference: 'feedface0000000000000000000000000000000000000000000000006af09f1f',
    round_secs: 60,
    settle_window_secs: 20,
    fee_bps: 100,
    finder_bps: 2000,
    ante: '10000000',
    paused: false,
    live_round: 0,
    presale_round: 2,
    finder_fees: '0',
    platform_fees: '0',
  });
  assert.deepEqual([s.id, s.ante, s.paused, s.liveRound, s.presaleRound, s.finderFees], [1, 10_000_000n, false, 0, 2, 0n]);
  assert.throws(() => parseSeries({ id: 1 }));
  const p = parsePosition({
    series_id: 1,
    round_index: 2,
    account_id: 'a.testnet',
    presale_up: '1',
    presale_down: '0',
    stake_up: '2',
    stake_down: '0',
    shares_up: '3',
    shares_down: '0',
  });
  assert.deepEqual([p.roundIndex, p.accountId, p.presaleUp, p.stakeUp, p.sharesUp], [2, 'a.testnet', 1n, 2n, 3n]);
  assert.deepEqual(parseQuote({ shares: '154150679', fee: '1010102', finder_fee: '202020', net: '100000000' }), {
    shares: 154_150_679n,
    fee: 1_010_102n,
    finderFee: 202_020n,
    net: 100_000_000n,
  });
  const c = parseConfig({ owner: 'atnx.testnet', keeper: 'keeper.atnx.testnet', treasury: 'atnx.testnet', token: 'usdg.atnx.testnet', fee_bps: 100, finder_bps: 2000, series_count: 6 });
  assert.equal(c.seriesCount, 6);
});

test('sides: "Up" / "Down" on the wire', () => {
  assert.equal(sideToNear('up'), 'Up');
  assert.equal(sideToNear('down'), 'Down');
  assert.equal(sideFromNear('Down'), 'down');
  assert.equal(sideFromNear(null), null);
  assert.throws(() => sideToNear('UP' as 'up'));
});

// ------------------------------------------------------------- accounts

test('isNearAccountId', () => {
  for (const ok of ['keeper.atnx.testnet', 'alice.testnet', 'e2emw82egl1.atnx.testnet', 'a_b-c.near', 'ab', '0'.repeat(64), '0x' + 'ab'.repeat(20)]) {
    assert.ok(isNearAccountId(ok), ok);
  }
  for (const bad of ['', 'a', 'Alice.testnet', 'a..testnet', '.testnet', 'testnet.', 'a-.testnet', 'a b', 'x'.repeat(65), '5a5yfYQBX3QYqWZ55agFTHQoxg5Lc4TvT8g3roMfqa2S']) {
    assert.ok(!isNearAccountId(bad), bad);
  }
});

test('parseNearSecret: ed25519 keys only, and the secret never in the message', () => {
  const kp = KeyPair.fromRandom('ed25519');
  assert.equal(parseNearSecret(kp.toString(), 'X').getPublicKey().toString(), kp.getPublicKey().toString());
  assert.throws(() => parseNearSecret(undefined, 'BM_NEAR_KEEPER_SECRET'), /BM_NEAR_KEEPER_SECRET is missing/);
  assert.throws(() => parseNearSecret('  ', 'X'), /missing/);
  const wrong = kp.toString().replace('ed25519:', 'secp256k1:');
  assert.throws(
    () => parseNearSecret(wrong, 'X'),
    (e: Error) => /not an "ed25519/.test(e.message) && !e.message.includes(wrong.slice(12))
  );
});

test('assertTestnet: anything else is refused', () => {
  assert.doesNotThrow(() => assertTestnet({ network: 'testnet', rpcUrl: '', rounds: '', usdg: '' }));
  assert.throws(() => assertTestnet({ network: 'mainnet', rpcUrl: '', rounds: '', usdg: '' }), /testnet only/);
});

// ---------------------------------------------------------------- faucet

test('faucetPlan: top up to 10,000 USDG in calls of at most 10,000', () => {
  const U = 1_000_000n;
  assert.equal(KEEPER_FLOAT, 10_000n * U);
  assert.deepEqual(faucetPlan(990n * U, 20n * U), []);
  assert.deepEqual(faucetPlan(19n * U, 20n * U), [9_981n * U]);
  assert.deepEqual(faucetPlan(0n, 10n * U), [10_000n * U]);
  assert.deepEqual(faucetPlan(0n, 25_000n * U), [MAX_FAUCET, MAX_FAUCET, 5_000n * U]);
  assert.deepEqual(faucetPlan(20n * U, 20n * U), []);
});

// ----------------------------------------------------------------- calls

// NearRounds with the network cut off: records each call's method and args.
class Recorder extends NearRounds {
  calls: { method: string; args: Record<string, unknown>; gas: bigint }[] = [];
  reply: unknown = undefined;
  constructor() {
    super({ accountId: 'keeper.atnx.testnet' } as unknown as Account, 'rounds.atnx.testnet');
  }
  override async call(method: string, args: Record<string, unknown>, gas?: bigint) {
    this.calls.push({ method, args, gas: gas ?? 0n });
    return { txHash: `tx-${method}`, value: this.reply };
  }
}

test('NearRounds: argument shapes the contract expects', async () => {
  const k = new Recorder();
  const ref = 'ab'.repeat(32);
  k.reply = 7;
  assert.deepEqual(await k.createSeries({ reference: ref, roundSecs: 60, settleWindowSecs: 20, ante: 10_000_000n, finder: 'alice.testnet' }), {
    txHash: 'tx-create_series',
    seriesId: 7,
  });
  await k.commit({ seriesId: 7, roundIndex: 1, side: 'down', amount: 10_000_000n });
  await k.openRound({ seriesId: 7, targetE2: 41_235n });
  await k.buy({ seriesId: 7, roundIndex: 1, side: 'up', amount: 5n, minShares: 4n });
  await k.settle({ seriesId: 7, settleE2: 41_232n, commitment: 'cd'.repeat(32) });
  await k.voidRound({ seriesId: 7, roundIndex: 2 });
  await k.setSeries({ seriesId: 7, paused: true });
  assert.deepEqual(
    k.calls.map((c) => [c.method, c.args]),
    [
      ['create_series', { reference: ref, round_secs: 60, settle_window_secs: 20, ante: '10000000', finder: 'alice.testnet' }],
      ['commit', { series_id: 7, round_index: 1, side: 'Down', amount: '10000000' }],
      ['open_round', { series_id: 7, target_e2: 41235 }],
      ['buy', { series_id: 7, round_index: 1, side: 'Up', amount: '5', min_shares: '4' }],
      ['settle', { series_id: 7, settle_e2: 41232, commitment: 'cd'.repeat(32) }],
      ['void_round', { series_id: 7, round_index: 2 }],
      ['set_series', { series_id: 7, paused: true }],
    ]
  );
});

test('NearRounds: return values, and refusals before anything is sent', async () => {
  const k = new Recorder();
  k.reply = '445500000';
  assert.deepEqual(await k.claim({ seriesId: 5, roundIndex: 1 }), { txHash: 'tx-claim', amount: 445_500_000n });
  k.reply = '10000000000';
  assert.deepEqual(await k.faucet(10_000_000_000n), { txHash: 'tx-faucet', credited: 10_000_000_000n });
  k.reply = '0';
  await assert.rejects(k.faucet(5n), /the mint failed/);
  k.reply = null;
  await assert.rejects(k.createSeries({ reference: 'ab'.repeat(32), roundSecs: 60, settleWindowSecs: 20, ante: 1n, finder: 'a.testnet' }), /unexpected return/);
  const before = k.calls.length;
  await assert.rejects(k.createSeries({ reference: 'AB'.repeat(32), roundSecs: 60, settleWindowSecs: 20, ante: 1n, finder: 'a.testnet' }), /reference/);
  await assert.rejects(k.createSeries({ reference: 'ab'.repeat(32), roundSecs: 60, settleWindowSecs: 20, ante: 1n, finder: 'Not An Account' }), /finder/);
  await assert.rejects(k.settle({ seriesId: 1, settleE2: 1n, commitment: '0x00' }), /commitment/);
  await assert.rejects(k.commit({ seriesId: 1, roundIndex: 0, side: 'up', amount: 1n }), /u32/);
  await assert.rejects(k.commit({ seriesId: 1, roundIndex: 1, side: 'up', amount: 0n }), /positive/);
  await assert.rejects(k.faucet(MAX_FAUCET + 1n), /cap/);
  await assert.rejects(k.openRound({ seriesId: 1, targetE2: 0n }), /positive/);
  assert.equal(k.calls.length, before, 'nothing was sent');
});
