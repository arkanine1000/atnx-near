// NEAR testnet operations for the rolling-rounds contracts (near/rounds at
// NEXT_PUBLIC_BM_NEAR_ROUNDS, near/usdg at NEXT_PUBLIC_BM_NEAR_USDG):
//
//   npm run rounds:near -- status            config, the keeper's balances, the series on chain
//   npm run rounds:near -- e2e               two short rounds end to end (below)
//   npm run rounds:near -- e2e --out <dir>   also write each settle's inputs JSON there, for
//                                            `npm run rounds:verify -- --onchain <id> <round> --inputs <file>`
//
// The e2e signs as the keeper (BM_NEAR_KEEPER_ACCOUNT / BM_NEAR_KEEPER_SECRET)
// and as a throwaway user it creates under the parent account
// (NEXT_PUBLIC_BM_NEAR_PARENT, default atnx.testnet, signing with
// BM_NEAR_PARENT_SECRET) with 0.05 NEAR, and deletes again at the end, so
// its NEAR goes back to the parent. The user is the series' finder; the
// keeper also plays the second trader. Round length 60 s, settlement
// window 20 s:
//
//   round 1: commits of 600 UP (user) and 400 DOWN (keeper), open at
//            100.00, a buy that nets exactly 100 UP and one of 50 DOWN
//            (shares checked against lib/bm/dpm.ts, by the contract's own
//            quote_buy too), the error paths, settle at 100.00 (a tie goes
//            UP) with an oracle commitment, the user rolls over into
//            round 2 and the keeper claims its losing position (0);
//   round 2: the keeper antes the empty DOWN side through lib/bm/near.ts
//            as the keeper step does, open, settle at 90.00 (DOWN), both
//            claim (payouts checked against dpm's payoutIf);
//   round 3: void while paused (refused before the pause), the series ends;
//   fees:    counters equal the expected fee ledger, withdraw_fees pays the
//            finder (the user) and the treasury, a second call is refused;
//   withdraw 10 USDG to the user's token account;
//   ledger:  the internal balances moved by exactly the rounding dust left
//            in the two rounds.
//
// It goes through lib/bm/near.ts, the same client the keeper uses. Spends
// a few thousandths of a NEAR in gas (printed at the end).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPair, nearToYocto, yoctoToNear, type Account } from 'near-api-js';
import { buildSettleInputs, settleCommitment, verifySettleInputs, type SettleInputs } from '../lib/bm/commitment';
import { feeSplit, payoutIf, quoteBuy as dpmQuote } from '../lib/bm/dpm';
import {
  NearCallError,
  NearRounds,
  gasBurnt,
  nearLastGas,
  tokensBurnt,
  assertTestnet,
  balanceOf,
  chainNowSecs,
  ensureKeeperUsdg,
  ftBalanceOf,
  ftTotalSupply,
  getConfig,
  getPosition,
  getRound,
  getSeries,
  getSeriesByReference,
  keeperRounds,
  nearAccount,
  nearEnv,
  nearKeeperAccountId,
  nearProvider,
  nearTxUrl,
  noteWrite,
  nearView,
  parseNearSecret,
  parseSeries,
  quoteBuy,
  type NearPosition,
  type NearRound,
  type NearSeries,
  type NearSideLower,
} from '../lib/bm/near';
import { refForSeries, refToHex } from '../lib/bm/series-ref';
import { rpcHosts } from '../lib/near/rpc';

const USDG = 1_000_000n;
const ROUND_SECS = 60;
const WINDOW_SECS = 20;
const USER_NEAR = '0.05';

const fmt = (units: bigint) => (Number(units) / 1e6).toFixed(6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 10)}…`;

function log(step: string, detail = '') {
  console.log(`  ${step}${detail ? `: ${detail}` : ''}`);
}

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function nearTotal(a: Account): Promise<bigint> {
  return (await a.getState()).balance.total;
}

async function status() {
  const env = nearEnv();
  const cfg = await getConfig();
  console.log(`rounds ${env.rounds}, usdg ${env.usdg}, rpc ${rpcHosts(env.rpcUrls)}`);
  console.log('config', cfg);
  const keeperId = nearKeeperAccountId();
  const k = keeperRounds();
  console.log(`keeper ${keeperId}: ${yoctoToNear((await k.account.getState()).balance.available, 4)} NEAR available, ${fmt(await balanceOf(keeperId))} USDG inside rounds`);
  const list = (await nearView('list_series', { from_index: 0, limit: 100 })) as unknown[];
  for (const s of list.map(parseSeries)) {
    console.log(`  series ${s.id}: ref ${short(s.reference)} ${s.roundSecs}s/${s.settleWindowSecs}s finder ${s.finder} live ${s.liveRound} presale ${s.presaleRound}${s.paused ? ' paused' : ''}`);
  }
}

async function e2e() {
  const env = nearEnv();
  const outDir = flag('--out');
  if (outDir) mkdirSync(outDir, { recursive: true });
  const keeperId = nearKeeperAccountId();
  const K = keeperRounds();
  const parentId = process.env.NEXT_PUBLIC_BM_NEAR_PARENT || 'atnx.testnet';
  const parent = nearAccount(parentId, parseNearSecret(process.env.BM_NEAR_PARENT_SECRET, 'BM_NEAR_PARENT_SECRET'));
  console.log(`rounds ${env.rounds}, usdg ${env.usdg}, keeper ${keeperId}, parent ${parentId}, rpc ${rpcHosts(env.rpcUrls)}`);

  const cfg = await getConfig();
  assert.equal(cfg.keeper, keeperId, `config keeper is ${cfg.keeper}`);
  assert.equal(cfg.token, env.usdg, `config token is ${cfg.token}`);
  assert.equal(cfg.feeBps, 100);
  assert.equal(cfg.finderBps, 2000);
  const treasury = cfg.treasury;
  const fee = BigInt(cfg.feeBps);
  const finderBps = BigInt(cfg.finderBps);

  // Each step with its transaction and the TGas it burnt.
  const txs: { step: string; hash: string; tgas: string }[] = [];
  const record = (step: string, hash: string, gas: bigint | null = nearLastGas()) => {
    txs.push({ step, hash, tgas: gas === null ? '' : (Number(gas) / 1e12).toFixed(2) });
    return hash;
  };
  const nearStart = { keeper: await nearTotal(K.account), parent: await nearTotal(parent) };
  const supplyStart = await ftTotalSupply();

  // Expected fee counters, kept beside the chain's.
  const ledger = { finder: 0n, platform: 0n };
  const charge = (amount: bigint) => {
    const s = feeSplit(amount, fee, finderBps);
    ledger.finder += s.finder;
    ledger.platform += s.platform;
    return s;
  };

  const mustRound = async (sid: number, idx: number): Promise<NearRound> => {
    const r = await getRound(sid, idx);
    assert.ok(r, `round ${idx} of series ${sid} missing`);
    return r;
  };
  const mustSeries = async (sid: number): Promise<NearSeries> => {
    const s = await getSeries(sid);
    assert.ok(s, `series ${sid} missing`);
    return s;
  };
  const mustPosition = async (sid: number, idx: number, who: string): Promise<NearPosition> => {
    const p = await getPosition(sid, idx, who);
    assert.ok(p, `position of ${who} in round ${idx} missing`);
    return p;
  };
  const sleepUntil = async (t: number, what: string) => {
    let now = await chainNowSecs();
    if (now >= t) return;
    log(`waiting ${t - now} s`, what);
    while (now < t) {
      await sleep(Math.min(5000, Math.max(1000, (t - now) * 1000)));
      now = await chainNowSecs();
    }
  };
  async function expectReject(label: string, code: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      const got = err instanceof NearCallError ? err.code : null;
      assert.equal(got, code, `${label}: expected "${code}", got ${got === null ? (err as Error).message : `"${got}"`}`);
      if (err instanceof NearCallError && err.txHash) record(`${label} (refused)`, err.txHash);
      log(`${label} refused`, code);
      // The refused call's gas refund lands a block later.
      await sleep(1500);
      return;
    }
    assert.fail(`${label}: expected "${code}", but it succeeded`);
  }
  const saveInputs = (name: string, inputs: SettleInputs) => {
    if (!outDir) return null;
    const p = join(outDir, name);
    writeFileSync(p, JSON.stringify(inputs, null, 2));
    return p;
  };

  // ------------------------------------------------------- 1. accounts
  const userId = `e2e${Date.now().toString(36)}.${parentId}`;
  const userKey = KeyPair.fromRandom('ed25519');
  const created = await parent.createSubAccount({ accountOrPrefix: userId, publicKey: userKey.getPublicKey(), nearToTransfer: nearToYocto(USER_NEAR) });
  record(`create ${userId}`, created.transaction.hash, gasBurnt(created));
  let accountBurnt = tokensBurnt(created);
  await noteWrite(created);
  // The new key has to be visible to whichever RPC node takes the user's
  // first transaction.
  for (let i = 0; i < 40; i++) {
    const ok = await nearProvider()
      .viewAccessKey({ accountId: userId, publicKey: userKey.getPublicKey() })
      .then(() => true, () => false);
    if (ok) break;
    await sleep(250);
  }
  const userAccount = nearAccount(userId, userKey);
  const U = new NearRounds(userAccount);
  log('user', `${userId} with ${USER_NEAR} NEAR`);

  let failed: unknown = null;
  // The series this run created, so a failed run can end it.
  let createdId: number | null = null;
  try {
    const faucet = await U.faucet(2_000n * USDG);
    record('user faucet 2,000', faucet.txHash);
    assert.equal(faucet.credited, 2_000n * USDG);
    assert.equal(await balanceOf(userId), 2_000n * USDG);
    const keeperBefore = await balanceOf(keeperId);
    const top = await ensureKeeperUsdg(1_000n * USDG);
    top.txHashes.forEach((h, i) => record(`keeper faucet top-up ${i + 1}`, h));
    log('funded', `user 2,000 USDG; keeper ${fmt(top.balance)} USDG${top.txHashes.length ? ' after a top-up to 10,000' : ''}`);
    const start = { user: await balanceOf(userId), keeper: await balanceOf(keeperId), treasury: await balanceOf(treasury) };
    assert.ok(start.keeper >= 1_000n * USDG);

    // --------------------------------------------------- 2. create series
    const marketId = randomUUID();
    const reference = refToHex(refForSeries(marketId, true, Math.floor(Date.now() / 1000)));
    const createdSeries = await K.createSeries({ reference, roundSecs: ROUND_SECS, settleWindowSecs: WINDOW_SECS, ante: 10n * USDG, finder: userId });
    record('create_series', createdSeries.txHash);
    const sid = createdSeries.seriesId;
    createdId = sid;
    let series = await mustSeries(sid);
    assert.deepEqual((await getSeriesByReference(reference))?.id, sid, 'get_series_by_reference finds it');
    assert.deepEqual(
      [series.finder, series.reference, series.roundSecs, series.settleWindowSecs, series.feeBps, series.finderBps, series.ante, series.liveRound, series.presaleRound, series.paused],
      [userId, reference, ROUND_SECS, WINDOW_SECS, 100, 2000, 10n * USDG, 0, 1, false]
    );
    assert.equal((await mustRound(sid, 1)).state, 'presale');
    log('create_series', `series ${sid}, ref ${reference}`);

    // ------------------------------------------------ 3. round 1 presale
    const commitAs = async (who: NearRounds, idx: number, side: NearSideLower, amount: bigint, step: string) => {
      charge(amount);
      return record(step, await who.commit({ seriesId: sid, roundIndex: idx, side, amount }));
    };
    await commitAs(U, 1, 'up', 600n * USDG, 'user commit UP 600 (r1)');
    await commitAs(K, 1, 'down', 400n * USDG, 'keeper commit DOWN 400 (r1)');
    let r1 = await mustRound(sid, 1);
    assert.equal(r1.presaleUp, 594n * USDG, 'U = 600 less 1 %');
    assert.equal(r1.presaleDown, 396n * USDG, 'D = 400 less 1 %');
    series = await mustSeries(sid);
    assert.deepEqual([series.finderFees, series.platformFees], [2n * USDG, 8n * USDG], 'finder 20 % and platform 80 % of 10 USDG fees');
    assert.deepEqual([series.finderFees, series.platformFees], [ledger.finder, ledger.platform]);
    assert.equal(await balanceOf(userId), start.user - 600n * USDG);
    log('presale r1', `U ${fmt(r1.presaleUp)}, D ${fmt(r1.presaleDown)}, fees finder ${fmt(series.finderFees)} / platform ${fmt(series.platformFees)}`);

    // ------------------------------------------------------- 4. open r1
    record('open_round r1 (target 100.00)', await K.openRound({ seriesId: sid, targetE2: 10_000n }));
    r1 = await mustRound(sid, 1);
    const T1 = r1.presaleUp + r1.presaleDown;
    assert.equal(r1.state, 'live');
    assert.deepEqual([r1.mUp, r1.mDown, r1.nUp, r1.nDown], [r1.presaleUp, r1.presaleDown, T1, T1]);
    assert.equal(r1.targetE2, 10_000n);
    assert.equal(r1.closeAt - r1.openedAt, ROUND_SECS);
    assert.equal(r1.tradeUntil, r1.closeAt - WINDOW_SECS);
    assert.equal((await mustRound(sid, 2)).state, 'presale');
    series = await mustSeries(sid);
    assert.deepEqual([series.liveRound, series.presaleRound], [1, 2]);
    log('open r1', `M = (${fmt(r1.mUp)}, ${fmt(r1.mDown)}), N = ${fmt(T1)} each, close ${new Date(r1.closeAt * 1000).toISOString()}`);

    // ------------------------------------------------------ 5. live buys
    const buyAs = async (who: NearRounds, side: NearSideLower, amount: bigint, step: string) => {
      const before = await mustRound(sid, 1);
      const q = dpmQuote(before, side, amount, fee, finderBps);
      const view = await quoteBuy(sid, 1, side, amount);
      assert.deepEqual([view.shares, view.fee, view.net], [q.shares, q.fee, q.net], `${step}: quote_buy equals dpm`);
      const posBefore = await getPosition(sid, 1, who.accountId);
      record(step, await who.buy({ seriesId: sid, roundIndex: 1, side, amount, minShares: q.shares }));
      charge(amount);
      const after = await mustRound(sid, 1);
      const pos = await mustPosition(sid, 1, who.accountId);
      const gained = side === 'up' ? pos.sharesUp - (posBefore?.sharesUp ?? 0n) : pos.sharesDown - (posBefore?.sharesDown ?? 0n);
      assert.equal(gained, q.shares, `${step}: chain shares ${gained} vs dpm ${q.shares}`);
      assert.deepEqual([after.mUp, after.mDown, after.nUp, after.nDown], [q.after.mUp, q.after.mDown, q.after.nUp, q.after.nDown], `${step}: pools`);
      return q;
    };
    const userBuy = await buyAs(U, 'up', 101_010_102n, 'user buy UP 101.010102 (r1)');
    assert.equal(userBuy.net, 100n * USDG, 'gross 101.010102 nets exactly 100');
    log('user buy UP', `net ${fmt(userBuy.net)} -> ${fmt(userBuy.shares)} shares (chain == quote_buy == dpm)`);
    const keeperBuy = await buyAs(K, 'down', 50n * USDG, 'keeper buy DOWN 50 (r1)');
    log('keeper buy DOWN', `net ${fmt(keeperBuy.net)} -> ${fmt(keeperBuy.shares)} shares (chain == quote_buy == dpm)`);

    // ------------------------------------------------------ 6. negatives
    // The slippage refusal first: it needs trading open.
    r1 = await mustRound(sid, 1);
    assert.ok((await chainNowSecs()) < r1.tradeUntil - 2, 'too slow: round 1 near the trading stop before the negatives');
    const q = dpmQuote(r1, 'up', 5n * USDG, fee, finderBps);
    await expectReject('buy above the quote', 'fewer shares than the minimum you set', () =>
      U.buy({ seriesId: sid, roundIndex: 1, side: 'up', amount: 5n * USDG, minShares: q.shares + 1n })
    );
    // UP, so that round 2 is one-sided after the user's UP rollover and the
    // keeper has to ante DOWN.
    await commitAs(U, 2, 'up', 20n * USDG, 'user commit UP 20 (r2)');
    await expectReject('commit into the live round', "round is not the series' presale round", () =>
      U.commit({ seriesId: sid, roundIndex: 1, side: 'up', amount: USDG })
    );
    await expectReject('buy in the presale round', "round is not the series' live round", () =>
      U.buy({ seriesId: sid, roundIndex: 2, side: 'up', amount: USDG, minShares: 0n })
    );
    await expectReject('settle by the user', 'not the keeper', () => U.settle({ seriesId: sid, settleE2: 10_000n, commitment: '0'.repeat(64) }));
    await expectReject('settle before close_at', 'round has not reached its close', () =>
      K.settle({ seriesId: sid, settleE2: 10_000n, commitment: '0'.repeat(64) })
    );
    await sleepUntil(r1.tradeUntil, 'trade_until (r1)');
    await expectReject('buy after trade_until', 'trading closed for the settlement window', () =>
      U.buy({ seriesId: sid, roundIndex: 1, side: 'up', amount: USDG, minShares: 0n })
    );

    // ------------------------------------ 7. settle r1 (UP) with commitment
    await sleepUntil(r1.closeAt, 'close_at (r1)');
    const inputs1 = buildSettleInputs({
      marketId,
      reference,
      roundIndex: 1,
      closeAt: r1.closeAt,
      windowSecs: WINDOW_SECS,
      rows: [
        { vi: 100.01, recorded_at: new Date((r1.closeAt - 5) * 1000).toISOString() },
        { vi: 99.99, recorded_at: new Date((r1.closeAt - 15) * 1000).toISOString() },
      ],
    })!;
    const c1 = settleCommitment(inputs1);
    assert.equal(inputs1.average_e2, 10_000);
    record('settle r1 (100.00 >= 100.00)', await K.settle({ seriesId: sid, settleE2: BigInt(inputs1.average_e2), commitment: c1.hash }));
    r1 = await mustRound(sid, 1);
    assert.equal(r1.state, 'settled');
    assert.equal(r1.winner, 'up', 'UP wins on settle == target');
    assert.equal(r1.settleE2, 10_000n);
    assert.equal(r1.commitment, c1.hash, 'the commitment is on chain');
    const v1 = verifySettleInputs(JSON.parse(JSON.stringify(inputs1)), r1, { marketId, reference, roundIndex: 1, windowSecs: WINDOW_SECS });
    assert.ok(v1.ok, v1.problems.join('; '));
    const file1 = saveInputs(`near-series-${sid}-round-1.json`, inputs1);
    series = await mustSeries(sid);
    assert.deepEqual([series.liveRound, series.presaleRound], [0, 2]);
    log('settle r1', `UP wins; commitment ${c1.hash} verifies${file1 ? ` (inputs in ${file1})` : ''}`);

    // --------------------------- 8. user rolls over, keeper claims (0)
    const userPos1 = await mustPosition(sid, 1, userId);
    const userDue = payoutIf(userPos1, r1, 'up');
    const roll = charge(userDue);
    const userBal0 = await balanceOf(userId);
    const rolled = await U.claimRollover({ seriesId: sid, roundIndex: 1 });
    record('user claim_rollover r1 -> r2', rolled.txHash);
    assert.equal(rolled.net, roll.net, 'returns payoutIf less the fee');
    const userPos2 = await mustPosition(sid, 2, userId);
    assert.equal(userPos2.presaleUp, 19_800_000n + roll.net, 'round-2 UP = the 20 commit plus the rolled net');
    assert.equal(await getPosition(sid, 1, userId), null, 'round-1 position deleted');
    assert.equal(await balanceOf(userId), userBal0, 'a rollover moves no balance');
    log('user rollover', `payout ${fmt(userDue)}, fee ${fmt(roll.fee)}, ${fmt(roll.net)} UP in round 2`);

    const keeperPos1 = await mustPosition(sid, 1, keeperId);
    assert.equal(payoutIf(keeperPos1, r1, 'up'), 0n, 'the keeper lost round 1');
    const keeperBal0 = await balanceOf(keeperId);
    const kc1 = await K.claim({ seriesId: sid, roundIndex: 1 });
    record('keeper claim r1 (0)', kc1.txHash);
    assert.equal(kc1.amount, 0n);
    assert.equal(await balanceOf(keeperId), keeperBal0);
    assert.equal(await getPosition(sid, 1, keeperId), null, 'keeper round-1 position deleted');
    r1 = await mustRound(sid, 1);
    assert.equal(r1.paidOut, userDue);
    const dust1 = r1.mUp + r1.mDown - r1.paidOut;
    log('keeper claim r1', `0 USDG, position deleted; round-1 dust ${dust1} units`);

    // ------------------------------- 9. round 2: ante, open, settle DOWN
    let r2 = await mustRound(sid, 2);
    assert.equal(r2.presaleUp, 19_800_000n + roll.net);
    assert.equal(r2.presaleDown, 0n, 'nobody on DOWN: the keeper has to ante');
    series = await mustSeries(sid);
    charge(series.ante);
    record('keeper ante DOWN 10 (r2)', await K.commit({ seriesId: sid, roundIndex: 2, side: 'down', amount: series.ante }));
    r2 = await mustRound(sid, 2);
    assert.equal(r2.presaleDown, 9_900_000n, 'ante 10 puts 9.90 in the pot');
    record('open_round r2', await K.openRound({ seriesId: sid, targetE2: 10_000n }));
    r2 = await mustRound(sid, 2);
    assert.equal(r2.state, 'live');
    assert.equal((await mustRound(sid, 3)).state, 'presale');
    series = await mustSeries(sid);
    assert.deepEqual([series.liveRound, series.presaleRound], [2, 3]);
    log('open r2', `U ${fmt(r2.presaleUp)}, D ${fmt(r2.presaleDown)}`);
    await sleepUntil(r2.closeAt, 'close_at (r2)');
    const inputs2 = buildSettleInputs({
      marketId,
      reference,
      roundIndex: 2,
      closeAt: r2.closeAt,
      windowSecs: WINDOW_SECS,
      rows: [{ vi: 90, recorded_at: new Date((r2.closeAt - 10) * 1000).toISOString() }],
    })!;
    const c2 = settleCommitment(inputs2);
    record('settle r2 (90.00 < 100.00)', await K.settle({ seriesId: sid, settleE2: BigInt(inputs2.average_e2), commitment: c2.hash }));
    r2 = await mustRound(sid, 2);
    assert.deepEqual([r2.state, r2.winner, r2.settleE2, r2.commitment], ['settled', 'down', 9_000n, c2.hash]);
    assert.ok(verifySettleInputs(inputs2, r2, { marketId, reference, roundIndex: 2, windowSecs: WINDOW_SECS }).ok);
    const file2 = saveInputs(`near-series-${sid}-round-2.json`, inputs2);
    log('settle r2', `DOWN wins; commitment ${c2.hash} verifies${file2 ? ` (inputs in ${file2})` : ''}`);

    const claimed: { who: string; amount: bigint }[] = [];
    for (const [name, who] of [
      ['keeper', K],
      ['user', U],
    ] as const) {
      const pos = await mustPosition(sid, 2, who.accountId);
      const due = payoutIf(pos, r2, 'down');
      const before = await balanceOf(who.accountId);
      const c = await who.claim({ seriesId: sid, roundIndex: 2 });
      record(`${name} claim r2`, c.txHash);
      assert.equal(c.amount, due, `${name}: claim returned ${c.amount}, payoutIf ${due}`);
      assert.equal((await balanceOf(who.accountId)) - before, due, `${name}: balance moved by the payout`);
      assert.equal(await getPosition(sid, 2, who.accountId), null, `${name} round-2 position deleted`);
      claimed.push({ who: name, amount: c.amount });
      log(`${name} claim r2`, `${fmt(c.amount)} USDG (== payoutIf)`);
    }
    r2 = await mustRound(sid, 2);
    const dust2 = r2.mUp + r2.mDown - r2.paidOut;

    // ------------------------------------------------ 10. pause and void
    await expectReject('void the presale round unpaused', 'series is not paused', () => K.voidRound({ seriesId: sid, roundIndex: 3 }));
    record('set_series paused', await K.setSeries({ seriesId: sid, paused: true }));
    series = await mustSeries(sid);
    assert.equal(series.paused, true);
    record('void_round r3 (presale)', await K.voidRound({ seriesId: sid, roundIndex: 3 }));
    assert.equal((await mustRound(sid, 3)).state, 'void');
    series = await mustSeries(sid);
    assert.deepEqual([series.liveRound, series.presaleRound], [0, 0]);
    log('pause + void', 'round 3 void, series ended');

    // --------------------------------------------------- 11. fees out
    assert.deepEqual([series.finderFees, series.platformFees], [ledger.finder, ledger.platform], 'fee counters equal the fee ledger');
    const finderFees = series.finderFees;
    const platformFees = series.platformFees;
    const userBefore = await balanceOf(userId);
    const treasuryBefore = await balanceOf(treasury);
    record('withdraw_fees (by the user)', await U.withdrawFees(sid));
    assert.equal((await balanceOf(userId)) - userBefore, finderFees, 'finder fees to the finder');
    assert.equal((await balanceOf(treasury)) - treasuryBefore, platformFees, 'platform fees to the treasury');
    series = await mustSeries(sid);
    assert.deepEqual([series.finderFees, series.platformFees], [0n, 0n]);
    await expectReject('withdraw_fees again', 'nothing to claim', () => U.withdrawFees(sid));
    log('withdraw_fees', `finder ${fmt(finderFees)}, treasury ${fmt(platformFees)}`);

    // ------------------------------------------------- 12. withdraw
    const w = await U.withdraw(10n * USDG);
    record('user withdraw 10', w.txHash);
    assert.equal(w.sent, 10n * USDG);
    assert.equal(await ftBalanceOf(userId), 10n * USDG, "10 USDG in the user's token account");
    log('withdraw', `10 USDG to ${userId}'s token account`);

    // ----------------------------------------------- 13. conservation
    const end = { user: await balanceOf(userId), keeper: await balanceOf(keeperId), treasury: await balanceOf(treasury) };
    const moved = end.user - start.user + (end.keeper - start.keeper) + (end.treasury - start.treasury) + w.sent;
    assert.equal(moved + dust1 + dust2, 0n, `internal balances moved by ${moved}, dust ${dust1} + ${dust2}`);
    assert.ok(dust1 + dust2 <= 10n, `rounding dust ${dust1 + dust2} units is too large`);
    const keeperNet = end.keeper - start.keeper;

    // ------------------------------------------------------- summary
    console.log('');
    console.table([
      { item: 'series', value: `${sid} (ref ${short(reference)})` },
      { item: 'round 1 pots (U / D)', value: `${fmt(594n * USDG)} / ${fmt(396n * USDG)}` },
      { item: 'user buy UP shares (chain == dpm)', value: fmt(userBuy.shares) },
      { item: 'keeper buy DOWN shares (chain == dpm)', value: fmt(keeperBuy.shares) },
      { item: 'user rollover into r2 (net)', value: fmt(roll.net) },
      ...claimed.map((c) => ({ item: `${c.who} claim r2`, value: fmt(c.amount) })),
      { item: 'fees: finder / treasury', value: `${fmt(finderFees)} / ${fmt(platformFees)}` },
      { item: 'keeper net USDG (trades + ante)', value: fmt(keeperNet) },
      { item: 'rounding dust (units)', value: `${dust1 + dust2} (r1 ${dust1}, r2 ${dust2})` },
      { item: 'r1 commitment', value: c1.hash },
      { item: 'r2 commitment', value: c2.hash },
    ]);
    const supplyEnd = await ftTotalSupply();
    console.log(`USDG total supply ${fmt(supplyStart)} -> ${fmt(supplyEnd)} (+${fmt(supplyEnd - supplyStart)}; the faucets minted ${fmt(2_000n * USDG + (top.balance - keeperBefore))} here, other testnet users may add to it)`);
    if (file1) console.log(`verify: npm run rounds:verify -- --onchain ${sid} 1 --inputs ${file1}`);
    console.log(`explorer: ${nearTxUrl(txs[0].hash)}`);
  } catch (err) {
    failed = err;
  } finally {
    // A failed run ends its series, so testnet keeps no half-run series: a
    // live round past its close is voided and the keeper's refund claimed,
    // then the presale round is voided under a pause. A live round still
    // trading is left for the keeper key to void after its close.
    if (failed && createdId !== null) {
      try {
        let s = await getSeries(createdId);
        if (s && s.liveRound > 0) {
          const live = await getRound(createdId, s.liveRound);
          if (live && (await chainNowSecs()) >= live.closeAt) {
            record(`cleanup: void live r${s.liveRound}`, await K.voidRound({ seriesId: createdId, roundIndex: s.liveRound }));
          } else {
            console.error(`cleanup: series ${createdId} round ${s.liveRound} is still trading; void it after its close`);
          }
        }
        for (let idx = 1; s && idx <= Math.max(s.liveRound, s.presaleRound); idx++) {
          const r = await getRound(createdId, idx);
          if (r && (r.state === 'settled' || r.state === 'void') && (await getPosition(createdId, idx, keeperId))) {
            record(`cleanup: keeper claim r${idx}`, (await K.claim({ seriesId: createdId, roundIndex: idx })).txHash);
          }
        }
        s = await getSeries(createdId);
        if (s && s.presaleRound > 0) {
          if (!s.paused) record('cleanup: pause', await K.setSeries({ seriesId: createdId, paused: true }));
          record(`cleanup: void presale r${s.presaleRound}`, await K.voidRound({ seriesId: createdId, roundIndex: s.presaleRound }));
        }
        log('cleanup', `series ${createdId} ended`);
      } catch (err) {
        console.error(`cleanup of series ${createdId} failed: ${(err as Error).message}`);
      }
    }
    // The throwaway user goes; its NEAR returns to the parent.
    try {
      const del = await userAccount.deleteAccount(parentId);
      record(`delete ${userId}`, del.transaction.hash, gasBurnt(del));
      accountBurnt += tokensBurnt(del);
      log('cleanup', `${userId} deleted, its NEAR back to ${parentId}`);
    } catch (err) {
      console.error(`could not delete ${userId}: ${(err as Error).message}`);
    }
  }
  console.log('');
  console.table(txs.map((t) => ({ step: t.step, tgas: t.tgas, tx: t.hash })));
  // Burnt by this run's own transactions; the balances can also move with
  // other activity on the same accounts, and refunds land a few blocks late.
  await sleep(4000);
  const nearEnd = { keeper: await nearTotal(K.account), parent: await nearTotal(parent) };
  const burnt = K.burnt + accountBurnt + U.burnt;
  console.log(
    `NEAR burnt by this run: ${yoctoToNear(burnt, 5)} (keeper ${yoctoToNear(K.burnt, 5)}, user ${yoctoToNear(U.burnt, 5)}, account create + delete ${yoctoToNear(accountBurnt, 5)}); ` +
      `balance change: keeper ${yoctoToNear(nearStart.keeper - nearEnd.keeper, 5)}, parent ${yoctoToNear(nearStart.parent - nearEnd.parent, 5)}`
  );
  if (failed) throw failed;
  console.log(`e2e OK on NEAR testnet (${env.rounds})`);
}

async function main() {
  assertTestnet();
  const cmd = process.argv[2] ?? 'e2e';
  if (cmd === 'status') return status();
  if (cmd === 'e2e') return e2e();
  throw new Error(`unknown command ${cmd} (status | e2e)`);
}

main().catch((err) => {
  console.error(err instanceof NearCallError ? `${err.message}${err.txHash ? ` (tx ${err.txHash})` : ''}` : err);
  process.exit(1);
});
