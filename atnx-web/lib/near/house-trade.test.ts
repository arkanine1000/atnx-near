import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, baseDecode, baseEncode } from 'near-api-js';
import type { HouseMarket, HouseQuote } from '../bm/house-types';
import { NearActError } from './client';
import { GUEST_CAPS } from './guest';
import {
  DEFAULT_KEY_FILE,
  DEFAULT_OPTIONS,
  EXIT,
  TradeExit,
  USDG,
  accountProof,
  closeLimitE2,
  decodeKeyFile,
  encodeKeyFile,
  faucetClaim,
  fmtPrice,
  fmtUsdg,
  fmtWindow,
  guestRefusal,
  isMarketRefusal,
  marketsToTry,
  newKeyRecord,
  openRefusal,
  orderCost,
  orderLimitE2,
  parseTradeArgs,
  refundMessage,
  relayErrorKind,
  relayErrorLine,
  stakeProblem,
  tooOpen,
  txProof,
} from './house-trade';

const CONTRACT = 'house.atnx.testnet';
const RELAYER = 'relayer.atnx.testnet';
const GUEST = 'guest-ab12cd34-h.atnx.testnet';

const CFG = { leadMinBps: 3_000, leadFullGapBps: 2_500, feeBps: 100, maxProfitBps: 90_000, minStake: 10n * USDG, maxStake: 250n * USDG } as const;

function quote(scoreE2: bigint, readingE2: bigint, printId = 1n): HouseQuote {
  return { scoreE2, pushedScoreE2: scoreE2, readingE2, printId, printAt: 1_000, firstReadAt: 1_010, lastReadAt: 1_010 };
}

function market(id: number, quotes: HouseQuote[], over: Partial<HouseMarket> = {}): HouseMarket {
  return { id, reference: 'a'.repeat(32), finder: null, liveSince: 0, status: 'Open', quotes, finalE2: null, long: null, short: null, opens: true, reason: null, ...over };
}

const exitOf = (fn: () => unknown): TradeExit => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TradeExit, `expected a TradeExit, got ${String(e)}`);
    return e;
  }
  assert.fail('expected a TradeExit');
};

// ---------------------------------------------------------------- flags

test('flags: the defaults are the live site, market 36, UP, 1x, 10 USDG, the key file here', () => {
  const o = parseTradeArgs([]);
  assert.equal(o.site, 'https://near.atnx.app');
  assert.equal(o.rpc, 'https://test.rpc.fastnear.com');
  assert.equal(o.contract, CONTRACT);
  assert.equal(o.market, 36);
  assert.equal(o.side, 'Long');
  assert.equal(o.leverage, 1);
  assert.equal(o.stake, 10_000_000n);
  assert.equal(o.keyFile, DEFAULT_KEY_FILE);
  assert.equal(o.keyFile, '.house-trade-key.json');
  assert.equal(o.fresh, false);
  assert.deepEqual(o, DEFAULT_OPTIONS);
});

test('flags: every flag is read', () => {
  const o = parseTradeArgs(['--site', 'http://localhost:3000/', '--market', '7', '--side', 'DOWN', '--stake', '25', '--key-file', '/tmp/k.json', '--fresh', '--rpc', 'https://rpc.testnet.near.org']);
  assert.equal(o.site, 'http://localhost:3000');
  assert.equal(o.market, 7);
  assert.equal(o.side, 'Short');
  assert.equal(o.stake, 25n * USDG);
  assert.equal(o.keyFile, '/tmp/k.json');
  assert.equal(o.fresh, true);
  assert.equal(o.rpc, 'https://rpc.testnet.near.org');
  assert.equal(parseTradeArgs(['--side', 'up']).side, 'Long');
  assert.equal(parseTradeArgs(['--help']).help, true);
  assert.equal(parseTradeArgs(['-h']).help, true);
});

test('flags: anything malformed is a usage error (exit 2)', () => {
  for (const argv of [
    ['--market'],
    ['--market', 'x'],
    ['--market', '-1'],
    ['--market', '1.5'],
    ['--side', 'long'],
    ['--side', 'sideways'],
    ['--stake', '0'],
    ['--stake', '10.5'],
    ['--stake', 'ten'],
    ['--site', 'near.atnx.app'],
    ['--site', 'ftp://example.com'],
    ['--key-file', '--fresh'],
    ['--leverage', '3'],
    ['stray'],
  ]) {
    assert.equal(exitOf(() => parseTradeArgs(argv)).code, EXIT.usage, argv.join(' '));
  }
});

test('flags: the stake has to be inside the contract limits', () => {
  assert.equal(stakeProblem(10n * USDG, CFG), null);
  assert.equal(stakeProblem(250n * USDG, CFG), null);
  assert.match(stakeProblem(9n * USDG, CFG)!, /10\.00 to 250\.00 USDG/);
  assert.match(stakeProblem(251n * USDG, CFG)!, /outside/);
  assert.equal(stakeProblem(1n, { minStake: null, maxStake: null }), null);
});

// ------------------------------------------------------------- key file

test('key file: a new key round-trips, and the file names its public key only once decoded', () => {
  const r = newKeyRecord(new Date('2026-11-11T00:00:00Z'));
  assert.match(r.publicKey, /^ed25519:/);
  assert.equal(KeyPair.fromString(r.secretKey as `ed25519:${string}`).getPublicKey().toString(), r.publicKey);
  const text = encodeKeyFile({ ...r, accountId: 'guest-ab12cd34.atnx.testnet', houseAccountId: GUEST, site: 'https://near.atnx.app' });
  const back = decodeKeyFile(text, '/k.json');
  assert.equal(back.publicKey, r.publicKey);
  assert.equal(back.secretKey, r.secretKey);
  assert.equal(back.houseAccountId, GUEST);
  assert.equal(back.site, 'https://near.atnx.app');
  // Two new keys differ.
  assert.notEqual(newKeyRecord().secretKey, r.secretKey);
});

test('key file: a file without publicKey derives it from the secret', () => {
  const r = newKeyRecord();
  assert.equal(decodeKeyFile(JSON.stringify({ secretKey: r.secretKey }), '/k.json').publicKey, r.publicKey);
});

test('key file: every problem is a usage error that never echoes the secret', () => {
  const r = newKeyRecord();
  const secret = r.secretKey;
  const body = secret.slice('ed25519:'.length);
  const other = newKeyRecord();
  // The right length, but its public half is not the seed's.
  const tampered = baseDecode(body);
  tampered[40] ^= 1;
  const cases: Array<[string, RegExp]> = [
    [`{"secretKey": "${secret}", oops}`, /not valid JSON/],
    [secret, /not valid JSON/],
    [`["${secret}"]`, /expected a JSON object/],
    [JSON.stringify({ secretKey: `ed25519:${body.slice(0, 20)}` }), /no ed25519 secretKey/],
    [JSON.stringify({ secretKey: `secp256k1:${body}` }), /no ed25519 secretKey/],
    [JSON.stringify({ secretKey: `ed25519:${'1'.repeat(80)}` }), /not a usable ed25519 key/],
    [JSON.stringify({ secretKey: `ed25519:${baseEncode(tampered)}` }), /not a usable ed25519 key/],
    [JSON.stringify({ publicKey: other.publicKey, secretKey: secret }), /does not belong/],
  ];
  for (const [text, why] of cases) {
    const e = exitOf(() => decodeKeyFile(text, '/home/x/.house-trade-key.json'));
    assert.equal(e.code, EXIT.usage);
    assert.match(e.message, why);
    assert.match(e.message, /^\/home\/x\/\.house-trade-key\.json: /);
    assert.match(e.message, /--fresh/);
    assert.ok(!e.message.includes(body), 'the secret is not in the message');
    assert.ok(!e.message.includes(body.slice(0, 12)), 'nor a piece of it');
  }
});

test('key file: the note says what it is; mode bits beyond the owner are too open', () => {
  const text = encodeKeyFile(newKeyRecord());
  assert.match(JSON.parse(text).note, /keep it private/);
  assert.equal(tooOpen(0o100600), false);
  assert.equal(tooOpen(0o100400), false);
  assert.equal(tooOpen(0o100644), true);
  assert.equal(tooOpen(0o100660), true);
});

// ---------------------------------------------------------- the numbers

test('numbers: USDG and prices are written exactly', () => {
  assert.equal(fmtUsdg(10_100_000n), '10.10');
  assert.equal(fmtUsdg(9_956_123n), '9.956123');
  assert.equal(fmtUsdg(10_000n * USDG), '10,000.00');
  assert.equal(fmtUsdg(-43_653n), '-0.043653');
  assert.equal(fmtUsdg(0n), '0.00');
  assert.equal(fmtPrice(116_221n), '1,162.21');
  assert.equal(fmtPrice(40_880n), '408.80');
  assert.equal(fmtPrice(5n), '0.05');
});

test('numbers: the order costs the stake and its 1 % fee, rounded up', () => {
  assert.equal(orderCost(10n * USDG, CFG), 10_100_000n);
  assert.equal(orderCost(10n * USDG, { feeBps: null }), 10_100_000n);
  assert.equal(orderCost(123n, CFG), 125n);
});

test('faucet: nothing when the balance covers the order; else the shortfall rounded up to 50 USDG', () => {
  const need = 10_100_000n;
  assert.equal(faucetClaim({ balance: need, need, claimed: 0n, cap: 10_000n * USDG }), null);
  assert.equal(faucetClaim({ balance: 0n, need, claimed: 0n, cap: 10_000n * USDG }), 50n * USDG);
  assert.equal(faucetClaim({ balance: 5n * USDG, need, claimed: 50n * USDG, cap: 10_000n * USDG }), 50n * USDG);
  // A 250 USDG order from nothing: 252.50 rounds up to 300.
  assert.equal(faucetClaim({ balance: 0n, need: 252_500_000n, claimed: 0n, cap: 10_000n * USDG }), 300n * USDG);
  // Never the 10,000 maximum, never past what is left.
  assert.equal(faucetClaim({ balance: 0n, need, claimed: 9_980n * USDG, cap: 10_000n * USDG }), 20n * USDG);
  assert.equal(faucetClaim({ balance: 0n, need, claimed: null, cap: null }), 50n * USDG);
  const e = exitOf(() => faucetClaim({ balance: 0n, need, claimed: 9_995n * USDG, cap: 10_000n * USDG }));
  assert.equal(e.code, EXIT.failed);
  assert.match(e.message, /faucet has only 5\.00 USDG left/);
});

test('limit: 1 % past the entry the ticket shows, rounded against the trader', () => {
  // S 400.00, R 420.00: buy 408.80, sell 400.00 (docs/house.md).
  const m = market(1, [quote(40_000n, 42_000n)]);
  const up = orderLimitE2({ cfg: CFG, market: m, side: 'Long', leverage: 1, stake: 10n * USDG })!;
  assert.deepEqual(up, { entryE2: 40_880n, limitE2: 41_289n }); // 408.80 × 1.01 = 412.888, up
  const down = orderLimitE2({ cfg: CFG, market: m, side: 'Short', leverage: 1, stake: 10n * USDG })!;
  assert.deepEqual(down, { entryE2: 40_000n, limitE2: 39_600n });
  // The close side: a long sells at 400.00, so its worst exit is 396.00; a
  // short buys back at 408.80, so 412.89.
  assert.deepEqual(closeLimitE2({ cfg: CFG, market: m, side: 'Long' }), { exitE2: 40_000n, limitE2: 39_600n });
  assert.deepEqual(closeLimitE2({ cfg: CFG, market: m, side: 'Short' }), { exitE2: 40_880n, limitE2: 41_289n });
  // The newest quote by print id is the one used.
  const two = market(1, [quote(40_000n, 42_000n, 1n), quote(116_221n, 115_000n, 2n)]);
  assert.equal(orderLimitE2({ cfg: CFG, market: two, side: 'Long', leverage: 1, stake: 10n * USDG })!.entryE2, 116_221n);
  // No quote, or a price of zero: no limit.
  assert.equal(orderLimitE2({ cfg: CFG, market: market(1, []), side: 'Long', leverage: 1, stake: 10n * USDG }), null);
  assert.equal(closeLimitE2({ cfg: CFG, market: null, side: 'Long' }), null);
  assert.equal(orderLimitE2({ cfg: CFG, market: market(1, [quote(0n, 0n)]), side: 'Short', leverage: 1, stake: 10n * USDG }), null);
});

test('markets: the asked-for one, then those that take orders after it, then before it, three at most', () => {
  const ms = [
    market(0, []),
    market(5, [], { opens: false, reason: 'the two prices are too far apart' }),
    market(20, []),
    market(36, []),
    market(37, [], { status: 'CloseOnly' }),
    market(40, []),
    market(41, []),
  ];
  assert.deepEqual(marketsToTry(36, ms), [36, 40, 41]);
  assert.deepEqual(marketsToTry(41, ms), [41, 0, 20]);
  assert.deepEqual(marketsToTry(36, ms, 10), [36, 40, 41, 0, 20]);
  // The asked-for market is tried even when not listed or closed: its
  // reason is printed and counts as one of the three.
  assert.deepEqual(marketsToTry(99, ms), [99, 0, 20]);
  assert.deepEqual(marketsToTry(5, ms), [5, 20, 36]);
  // A view without `opens` counts as taking orders.
  assert.deepEqual(marketsToTry(1, [{ id: 2, status: 'Open', opens: null }]), [1, 2]);
});

// --------------------------------------------------------- the refusals

test('guest refusals: the caps get exit 3 and say the window and the way round it', () => {
  const ip = guestRefusal(429, { error: 'guest_limit_ip' });
  assert.equal(ip.code, EXIT.guestLimit);
  assert.equal(ip.code, 3);
  assert.match(ip.message, /per-network limit on new guest accounts was reached/);
  assert.match(ip.message, /rolling hour/);
  assert.match(ip.message, /at most an hour from now/);
  assert.match(ip.message, /--key-file/);
  assert.equal(ip.message.split(/\.\s/).length, 1, 'one sentence');
  const day = guestRefusal(429, { error: 'guest_limit_day' });
  assert.equal(day.code, EXIT.guestLimit);
  assert.match(day.message, /rolling 24 hours/);
  assert.match(day.message, /--key-file/);
  // The window comes from the caps the site runs.
  assert.match(guestRefusal(429, { error: 'guest_limit_ip' }, { ...GUEST_CAPS, ipWindowSecs: 7_200 }).message, /rolling 2 hours/);
});

test('guest refusals: everything else is exit 1 with its reason', () => {
  for (const [status, error, re] of [
    [503, 'relayer_empty', /low on NEAR/],
    [404, 'not_found', /NEAR guest accounts/],
    [503, 'not_configured', /NEAR guest accounts/],
    [409, 'key_used', /--fresh/],
    [409, 'house_account_clash', /--fresh/],
    [400, 'bad_public_key', /malformed/],
    [502, 'create_failed', /HTTP 502, create_failed/],
  ] as const) {
    const e = guestRefusal(status, { error });
    assert.equal(e.code, EXIT.failed, error);
    assert.match(e.message, re, error);
  }
  assert.match(guestRefusal(504, {}).message, /HTTP 504, http_504/);
  assert.match(guestRefusal(502, { error: 'create_failed', detail: 'x'.repeat(500) }).message.slice(-20), /x+\)\.$/);
});

test('windows: written as the messages say them', () => {
  assert.equal(fmtWindow(3_600), 'an hour');
  assert.equal(fmtWindow(7_200), '2 hours');
  assert.equal(fmtWindow(86_400), '24 hours');
  assert.equal(fmtWindow(172_800), '2 days');
  assert.equal(fmtWindow(900), '15 minutes');
});

test('relay errors: nothing sent is retried, maybe sent is looked for, the rest is a refusal', () => {
  const e = (code: string, status = 400, msg: string | null = null) => new NearActError(code, status, msg, null);
  for (const code of ['rpc_busy', 'busy', 'stale_nonce', 'expired', 'server_error']) assert.equal(relayErrorKind(e(code, 503)), 'retry', code);
  for (const code of ['rpc_unsure', 'relay_error', 'http_502', 'http_504']) assert.equal(relayErrorKind(e(code, 503)), 'unsure', code);
  for (const code of ['would_fail', 'failed_on_chain', 'rate_limited', 'faucet_full', 'method_not_allowed', 'not_a_guest', 'no_account', 'http_404']) {
    assert.equal(relayErrorKind(e(code)), 'refused', code);
  }
  // No answer at all.
  assert.equal(relayErrorKind(new Error('The operation was aborted due to timeout')), 'unsure');
  assert.equal(relayErrorKind(new TypeError('fetch failed')), 'unsure');
  assert.equal(relayErrorLine(e('would_fail', 400, 'the two prices are too far apart')), 'would_fail (HTTP 400): the two prices are too far apart');
  assert.equal(relayErrorLine(e('rpc_busy', 503)), 'rpc_busy (HTTP 503)');
  assert.equal(relayErrorLine(new Error('first line\nsecond')), 'first line');
});

test('order refusals: a market reason moves on, an account reason stops', () => {
  const refused = (msg: string, code = 'would_fail') => new NearActError(code, code === 'would_fail' ? 400 : 422, msg, null);
  for (const msg of ['the two prices are too far apart', "the market's newest quote is too old", 'score is under the minimum to open', 'market is not open', 'market is inside its cool-off', 'no such market', 'market has no quote', 'the price is zero']) {
    assert.deepEqual(openRefusal(refused(msg)), { kind: 'market', reason: msg }, msg);
    assert.equal(openRefusal(refused(msg, 'failed_on_chain')).kind, 'market', msg);
    assert.equal(isMarketRefusal(msg), true);
  }
  for (const msg of ['balance too low', 'position limit reached for this account', 'stake below the minimum', 'new orders are paused', 'the contract is under its storage floor']) {
    assert.deepEqual(openRefusal(refused(msg)), { kind: 'stop', reason: msg }, msg);
  }
  assert.equal(isMarketRefusal(null), false);
  assert.deepEqual(openRefusal(new NearActError('rate_limited', 429, null, null)), { kind: 'stop', reason: 'rate_limited (HTTP 429)' });
});

test('refunds: the contract reason name and the ticket sentence', () => {
  assert.equal(refundMessage('spread'), 'spread: Not filled: the two prices were too far apart. Your stake and fee are back in your balance.');
  assert.match(refundMessage('full'), /^market_full: Not filled: the market was full/);
  assert.match(refundMessage('limit'), /^limit: /);
  assert.equal(refundMessage(null), 'Not filled. Your stake and fee are back in your balance.');
});

// ------------------------------------------------------------ the proof

function delegateTx(over: { signer?: string; sender?: string; receiver?: string; method?: string; status?: unknown; extraAction?: boolean } = {}) {
  const actions: unknown[] = [
    {
      Delegate: {
        delegate_action: {
          sender_id: over.sender ?? GUEST,
          receiver_id: over.receiver ?? CONTRACT,
          actions: [{ FunctionCall: { method_name: over.method ?? 'open', args: 'e30=', gas: 30_000_000_000_000, deposit: '0' } }],
          nonce: 5,
          max_block_height: 100,
          public_key: 'ed25519:x',
        },
        signature: 'ed25519:sig',
      },
    },
  ];
  if (over.extraAction) actions.push({ Transfer: { deposit: '1' } });
  return { status: over.status ?? { SuccessValue: '' }, transaction: { signer_id: over.signer ?? RELAYER, receiver_id: over.sender ?? GUEST, actions, hash: 'H' } };
}

const EXPECT = { relayer: RELAYER, sender: GUEST, contract: CONTRACT, method: 'open' };

test('proof: a relayed call is a relayer transaction holding one Delegate from the guest to the contract', () => {
  const ok = txProof('H', delegateTx(), EXPECT);
  assert.deepEqual(ok, { hash: 'H', signer: RELAYER, sender: GUEST, receiver: CONTRACT, method: 'open', succeeded: true, problems: [] });
  assert.match(txProof('H', delegateTx({ signer: GUEST }), EXPECT).problems[0], /signed by guest-ab12cd34-h\.atnx\.testnet, not relayer/);
  assert.match(txProof('H', delegateTx({ sender: 'someone.testnet' }), EXPECT).problems[0], /from someone\.testnet/);
  assert.match(txProof('H', delegateTx({ receiver: 'rounds.atnx.testnet' }), EXPECT).problems[0], /calls rounds\.atnx\.testnet/);
  assert.match(txProof('H', delegateTx({ method: 'withdraw' }), EXPECT).problems[0], /calls withdraw, not open/);
  assert.match(txProof('H', delegateTx({ status: { Failure: {} } }), EXPECT).problems[0], /did not succeed/);
  assert.match(txProof('H', delegateTx({ extraAction: true }), EXPECT).problems[0], /not one Delegate action/);
  assert.ok(txProof('H', {}, EXPECT).problems.length >= 2);
});

test('proof: the account holds 0 NEAR and one function-call key for the contract, this one', () => {
  const pk = newKeyRecord().publicKey;
  const fcKey = (over: Record<string, unknown> = {}) => ({
    public_key: pk,
    access_key: { nonce: 9, permission: { FunctionCall: { allowance: '250000000000000000000000', receiver_id: CONTRACT, method_names: [], ...over } } },
  });
  const ok = accountProof({ amount: '0', locked: '0' }, { keys: [fcKey()] }, { publicKey: pk, contract: CONTRACT });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.amount, 0n);
  assert.deepEqual(ok.keys, [`${pk} function call on ${CONTRACT}, no method list, allowance 0.25 NEAR`]);
  const exp = { publicKey: pk, contract: CONTRACT };
  assert.match(accountProof({ amount: '1000000000000000000000000' }, { keys: [fcKey()] }, exp).problems[0], /holds 1 NEAR, not 0/);
  assert.match(accountProof({}, { keys: [fcKey()] }, exp).problems[0], /could not be read/);
  assert.match(accountProof({ amount: '0' }, { keys: [fcKey(), fcKey()] }, exp).problems[0], /2 access keys, not 1/);
  assert.match(accountProof({ amount: '0' }, { keys: [] }, exp).problems[0], /0 access keys/);
  assert.match(accountProof({ amount: '0' }, { keys: [{ public_key: pk, access_key: { permission: 'FullAccess' } }] }, exp).problems[0], /not a function-call key/);
  assert.match(accountProof({ amount: '0' }, { keys: [fcKey({ receiver_id: 'rounds.atnx.testnet' })] }, exp).problems[0], /for rounds\.atnx\.testnet/);
  assert.match(accountProof({ amount: '0' }, { keys: [fcKey()] }, { publicKey: newKeyRecord().publicKey, contract: CONTRACT }).problems[0], /not this run's key/);
  assert.match(accountProof({ amount: '0' }, { keys: [fcKey({ method_names: ['open'] })] }, exp).keys[0], /methods open/);
});

test('exit codes: one per outcome, all different', () => {
  const codes = Object.values(EXIT);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(EXIT, { ok: 0, failed: 1, usage: 2, guestLimit: 3, noMarket: 4, timeout: 5, proof: 6 });
});
