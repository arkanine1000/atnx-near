// The NEAR web layer's server path on testnet, without a browser:
//
//   npm run near:e2e                 a new user account, then faucet and a commit, relayed
//   npm run near:e2e -- --full       ... plus a whole 60-second round: commits on both
//                                    sides, open, a live buy, settle, claim
//   npm run near:e2e -- --series 3   commit into an existing series' presale round instead
//                                    of creating one (series creation is keeper-only)
//
// It runs the same code as the routes: handleAccountCreate with the parent
// key (lib/near/server.ts parentAccountChain), and handleRelay with the
// relayer, the policy and the rounds checks, all against the in-memory
// store (nothing touches Supabase). The user's key is a WebCrypto Ed25519
// key made the way the browser makes it (lib/near/signer.ts), and every
// call is signed by lib/near/client.ts, the browser's signer. At the end
// it checks the user's NEAR balance never moved from 0.
//
// Needs .env.local: NEXT_PUBLIC_BM_NEAR_RPC, NEXT_PUBLIC_BM_NEAR_ROUNDS,
// NEXT_PUBLIC_BM_NEAR_PARENT, BM_NEAR_PARENT_SECRET, BM_NEAR_RELAYER_ACCOUNT,
// BM_NEAR_RELAYER_SECRET, and for a new series BM_NEAR_KEEPER_SECRET
// (keeper.atnx.testnet; BM_NEAR_KEEPER_ACCOUNT overrides).
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, type KeyPairString } from 'near-api-js';
import { quoteBuy } from '../lib/bm/dpm';
import { FAUCET_UNITS, NEAR_NETWORK, NEAR_PARENT, NEAR_ROUNDS, NEAR_RPC, USER_METHODS } from '../lib/near/config';
import { NearActError, createActor, signCall, type FetchLike } from '../lib/near/client';
import { createRelayer, roundsRelayPolicy } from '../lib/near/relay';
import { roundsAppCheck } from '../lib/near/rounds-check';
import { callArgs, nearDue, roundsViewer, u128 } from '../lib/near/rounds';
import { handleAccountCreate, handleRelay, type RelayDeps, type RouteUser } from '../lib/near/routes';
import { parentAccountChain } from '../lib/near/server-chain';
import { WebCryptoSigner } from '../lib/near/signer';
import { memoryNearAccountStore } from '../lib/near/store';

const TGAS = 10n ** 12n;
const USDG = 1_000_000n;
const ZERO_COMMITMENT = '0'.repeat(64);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (run with --env-file=.env.local)`);
  return v;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const near = (yocto: bigint | null) => (yocto === null ? 'n/a' : `${(Number(yocto) / 1e24).toFixed(6)} NEAR`);
const usdg = (units: bigint) => `${(Number(units) / 1e6).toFixed(6)} USDG`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A read right after a relayed call can hit an RPC node a block behind the
// one that ran it: poll until the state shows the call.
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const v = await read();
    if (ok(v)) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const txs: Array<{ step: string; hash: string | null }> = [];
function log(step: string, detail = '', hash: string | null = null) {
  if (hash) txs.push({ step, hash });
  console.log(`  ${step.padEnd(22)} ${detail}${hash ? `  tx ${hash}` : ''}`);
}

async function main() {
  const full = process.argv.includes('--full');
  const seriesArg = arg('--series');
  const rpcUrl = NEAR_RPC;
  const roundsId = NEAR_ROUNDS || env('NEXT_PUBLIC_BM_NEAR_ROUNDS');
  const parentId = NEAR_PARENT || env('NEXT_PUBLIC_BM_NEAR_PARENT');
  const relayerId = env('BM_NEAR_RELAYER_ACCOUNT');
  if (NEAR_NETWORK !== 'testnet' || !parentId.endsWith('.testnet') || /mainnet/.test(rpcUrl)) throw new Error('testnet only');

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const view = roundsViewer({ provider, contractId: roundsId });
  const keeperId = process.env.BM_NEAR_KEEPER_ACCOUNT || 'keeper.atnx.testnet';
  const before = {
    parent: await view.nearBalance(parentId),
    relayer: await view.nearBalance(relayerId),
    keeper: await view.nearBalance(keeperId),
    rounds: await view.nearBalance(roundsId),
  };
  console.log(`NEAR relay e2e on ${rpcUrl}: rounds ${roundsId}, parent ${parentId}, relayer ${relayerId}`);

  // ---------------------------------------------------------- the account
  const signer = await WebCryptoSigner.generate();
  const store = memoryNearAccountStore();
  const user: RouteUser = { id: randomUUID(), username: `e2e-${Date.now().toString(36).slice(-6)}` };
  const accountDeps = {
    store,
    chain: parentAccountChain({ rpcUrl, parentId, parentKey: env('BM_NEAR_PARENT_SECRET'), roundsId }),
    parentId,
  };
  const created = await handleAccountCreate(accountDeps, user, { publicKey: signer.publicKeyString });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const accountId = String(created.body.accountId);
  log('account', `${accountId} (key ${signer.publicKeyString.slice(0, 20)}…)`, String(created.body.txHash));
  const again = await handleAccountCreate(accountDeps, user, { publicKey: signer.publicKeyString });
  assert.equal(again.status, 200, 'a second POST with the same key returns the account');
  const nearAtStart = await view.nearBalance(accountId);
  log('user NEAR at start', near(nearAtStart));
  assert.equal(nearAtStart, 0n, 'the account is created with zero NEAR');
  const key = await provider.viewAccessKey({ accountId, publicKey: PublicKey.from(signer.publicKeyString) });
  const perm = key.permission as { FunctionCall?: { receiver_id: string; method_names: string[] } };
  assert.equal(perm.FunctionCall?.receiver_id, roundsId, 'the key is scoped to the rounds contract');
  assert.deepEqual([...(perm.FunctionCall?.method_names ?? [])].sort(), [...USER_METHODS].sort(), 'and to the user methods');

  // ------------------------------------------------------------ the relay
  const relayer = createRelayer({ relayerId, relayerKey: env('BM_NEAR_RELAYER_SECRET'), rpcUrl, policy: roundsRelayPolicy(roundsId, parentId, USER_METHODS) });
  const relayDeps: RelayDeps = { store, relayer, appCheck: roundsAppCheck(view) };
  // The browser POSTs to /api/near/relay; here the same handler is called directly.
  const relayFetch: FetchLike = async (_url, init) => {
    const r = await handleRelay(relayDeps, user, JSON.parse(init.body));
    return { status: r.status, json: async () => r.body };
  };
  const { act } = createActor({ accountId, signer, rpcUrl, contractId: roundsId, fetch: relayFetch });

  const f = await act('faucet', callArgs.faucet(FAUCET_UNITS));
  assert.equal(f.value, FAUCET_UNITS.toString(), 'faucet returns the amount credited');
  await eventually(() => view.balanceOf(accountId), (b) => b === FAUCET_UNITS, 'the faucet credit');
  log('faucet', `credited ${usdg(u128(f.value))}`, f.txHash);

  // ----------------------------------------------------------- the series
  let seriesId: number;
  let keeper: Account | null = null;
  if (seriesArg) {
    seriesId = Number(seriesArg);
  } else {
    keeper = new Account(keeperId, provider, new KeyPairSigner(KeyPair.fromString(env('BM_NEAR_KEEPER_SECRET') as KeyPairString)));
    const reference = `e2e0${randomBytes(30).toString('hex')}`;
    seriesId = await keeper.callFunction<number>({
      contractId: roundsId,
      methodName: 'create_series',
      args: { reference, round_secs: 60, settle_window_secs: 20, ante: '0', finder: parentId },
      gas: 30n * TGAS,
    });
    log('create_series (keeper)', `series ${seriesId}, 60 s rounds, reference ${reference.slice(0, 12)}…`, null);
  }
  const series = await view.series(seriesId);
  assert.ok(series, `series ${seriesId} exists`);
  assert.ok(series.presaleRound > 0, 'the series has a presale round');
  const presale = series.presaleRound;

  const c = await act('commit', callArgs.commit(seriesId, presale, 'up', 25n * USDG));
  const pos = await eventually(() => view.position(seriesId, presale, accountId), (p) => !!p, 'the commit');
  assert.equal(pos?.presaleUp, 25n * USDG - 250_000n, 'the commit is in the presale pot, net of the 1 % fee');
  assert.equal(c.events.find((e) => e.event === 'commit')?.data.account, accountId);
  log('commit UP 25', `round ${presale}: position ${usdg(pos!.presaleUp)} net`, c.txHash);

  // --------------------------------------------- refusals that cost nothing
  const relayerBefore = await view.nearBalance(relayerId);
  await assert.rejects(act('commit', callArgs.commit(seriesId, presale + 1, 'up', USDG)), (e: unknown) => e instanceof NearActError && e.code === 'would_fail' && e.contractMessage === "round is not the series' presale round");
  log('refused: wrong round', 'would_fail, not sent');
  await assert.rejects(act('commit', callArgs.commit(seriesId, presale, 'up', 2_000n * USDG)), (e: unknown) => e instanceof NearActError && e.contractMessage === 'balance too low');
  log('refused: over balance', 'would_fail, not sent');
  const signed = await signCall({ provider, accountId, signer, contractId: roundsId, methodName: 'commit', args: callArgs.commit(seriesId, presale, 'up', USDG), gas: 30n * TGAS });
  const first = await relayFetch('/api/near/relay', { method: 'POST', headers: {}, body: JSON.stringify({ signedDelegate: signed.signedDelegateBase64 }) });
  assert.equal(first.status, 200);
  const replay = await relayFetch('/api/near/relay', { method: 'POST', headers: {}, body: JSON.stringify({ signedDelegate: signed.signedDelegateBase64 }) });
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error: string }).error, 'stale_nonce');
  log('refused: replay', 'stale_nonce, not sent');
  const notAllowed = await signCall({ provider, accountId, signer, contractId: roundsId, methodName: 'withdraw_fees', args: { series_id: seriesId }, gas: 30n * TGAS });
  const na = await relayFetch('/api/near/relay', { method: 'POST', headers: {}, body: JSON.stringify({ signedDelegate: notAllowed.signedDelegateBase64 }) });
  assert.equal(((await na.json()) as { error: string }).error, 'method_not_allowed');
  log('refused: withdraw_fees', 'method_not_allowed, not sent');
  const relayerAfterRefusals = await view.nearBalance(relayerId);
  // Only the one good commit (the replay's original) was paid for in between.
  log('relayer spent', `${near((relayerBefore ?? 0n) - (relayerAfterRefusals ?? 0n))} over 1 relayed commit and 4 refusals`);

  // ---------------------------------------------------------- a full round
  if (full) {
    if (!keeper) throw new Error('--full needs its own series (drop --series)');
    const d = await act('commit', callArgs.commit(seriesId, presale, 'down', 10n * USDG));
    log('commit DOWN 10', `round ${presale}`, d.txHash);
    await keeper.callFunction({ contractId: roundsId, methodName: 'open_round', args: { series_id: seriesId, target_e2: 10_000 }, gas: 30n * TGAS });
    const live = await eventually(() => view.round(seriesId, presale), (r) => r?.state === 'live', 'the open');
    log('open_round (keeper)', `round ${presale} live, target 100.00, closes at ${new Date(live!.closeAt * 1000).toISOString()}`);

    const s = (await view.series(seriesId))!;
    await eventually(() => view.position(seriesId, presale, accountId), (p) => !!p && p.presaleDown > 0n, 'the DOWN commit');
    const spend = 5n * USDG;
    const chainQuote = await view.quoteBuy(seriesId, presale, 'up', spend);
    const tsQuote = quoteBuy(live!, 'up', spend, BigInt(s.feeBps), BigInt(s.finderBps));
    assert.equal(tsQuote.shares, chainQuote.shares, 'dpm.ts quotes the same shares as quote_buy');
    const minShares = (chainQuote.shares * 99n) / 100n;
    const b = await act('buy', callArgs.buy(seriesId, presale, 'up', spend, minShares));
    log('buy UP 5', `${usdg(chainQuote.shares)} shares (dpm.ts agrees)`, b.txHash);

    const wait = live!.closeAt * 1000 - Date.now() + 3_000;
    console.log(`  waiting ${Math.ceil(wait / 1000)} s for the close…`);
    if (wait > 0) await sleep(wait);
    for (let i = 0; ; i++) {
      try {
        await keeper.callFunction({ contractId: roundsId, methodName: 'settle', args: { series_id: seriesId, settle_e2: 10_100, commitment: ZERO_COMMITMENT }, gas: 30n * TGAS });
        break;
      } catch (e) {
        if (i >= 5 || !/has not reached its close/.test(String((e as Error).message))) throw e;
        await sleep(5_000);
      }
    }
    const settled = (await eventually(() => view.round(seriesId, presale), (r) => r?.state === 'settled', 'the settle'))!;
    assert.equal(settled.winner, 'up');
    log('settle (keeper)', `average 101.00 vs target 100.00: UP wins`);

    const mine = (await eventually(() => view.position(seriesId, presale, accountId), (p) => !!p && p.stakeUp > 0n && p.presaleDown > 0n, 'the buy and the DOWN commit'))!;
    const due = nearDue(settled, mine);
    const balBefore = await view.balanceOf(accountId);
    const cl = await act('claim', callArgs.claim(seriesId, presale));
    assert.equal(u128(cl.value), due, 'claim returns what dpm.ts says the position is owed');
    await eventually(() => view.balanceOf(accountId), (b) => b - balBefore === due, 'the claim credit');
    assert.equal(await eventually(() => view.position(seriesId, presale, accountId), (p) => p === null, 'the position removed'), null);
    log('claim', `paid ${usdg(due)} (returned by the call, matches dpm.ts)`, cl.txHash);
  }

  // --------------------------------------------------------------- totals
  const nearAtEnd = await view.nearBalance(accountId);
  const after = {
    parent: await view.nearBalance(parentId),
    relayer: await view.nearBalance(relayerId),
    keeper: await view.nearBalance(keeperId),
    rounds: await view.nearBalance(roundsId),
  };
  console.log('');
  log('user NEAR at end', near(nearAtEnd));
  assert.equal(nearAtEnd, 0n, "the user's NEAR balance stayed 0");
  log('user USDG', usdg(await view.balanceOf(accountId)));
  const spent = (k: keyof typeof before) => (before[k] ?? 0n) - (after[k] ?? 0n);
  console.log(`  spent: parent ${near(spent('parent'))}, relayer ${near(spent('relayer'))}, keeper ${near(spent('keeper'))}, rounds storage ${near(spent('rounds'))}`);
  console.log(`  total ${near(spent('parent') + spent('relayer') + spent('keeper') + spent('rounds'))}`);
  console.log('  transactions:');
  for (const t of txs) console.log(`    ${t.step.padEnd(22)} ${t.hash}`);
  console.log('OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
