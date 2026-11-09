// The guest path on testnet, without a browser and without the database:
//
//   npm run near:guest:e2e                a guest account, a faucet, then a commit into a
//                                         20-minute series made for it, paused, voided and
//                                         claimed back
//   npm run near:guest:e2e -- --series 9  commit into an existing series' presale round
//                                         instead (nothing is paused)
//
// It runs the same code as the routes: handleGuestCreate with the parent key
// (lib/near/server-chain.ts parentAccountChain, as /api/near/guest), and
// handleRelay's guest branch with no session (as /api/near/relay with
// guest: true), the relayer, its policy and the rounds checks, all against
// the in-memory stores: bm.near_guests is not touched (005 may not be
// applied). The guest's key is a WebCrypto Ed25519 key made the way the
// browser makes it, and every call is signed by lib/near/client.ts.
//
// The series is created with the keeper key directly on chain, not through
// the registry, so the site never lists it; the keeper pauses it and voids
// its presale round at the end, and the guest claims its commit back. At the
// end it checks the guest's NEAR balance never moved from 0, and that the
// run spent under 0.1 NEAR in all.
//
// Needs .env.local: NEXT_PUBLIC_BM_NEAR_RPC, NEXT_PUBLIC_BM_NEAR_ROUNDS,
// NEXT_PUBLIC_BM_NEAR_PARENT, BM_NEAR_PARENT_SECRET, BM_NEAR_RELAYER_ACCOUNT,
// BM_NEAR_RELAYER_SECRET, and for the series BM_NEAR_KEEPER_SECRET.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions, type KeyPairString } from 'near-api-js';
import { successValue, txHashOf } from '../lib/bm/near';
import { FAUCET_UNITS, NEAR_NETWORK, NEAR_PARENT, NEAR_ROUNDS, NEAR_RPC, USER_METHODS } from '../lib/near/config';
import { NearActError, createActor, signCall, type FetchLike } from '../lib/near/client';
import { hashIp, isGuestAccountId } from '../lib/near/guest';
import { createRelayer, roundsRelayPolicy } from '../lib/near/relay';
import { roundsAppCheck } from '../lib/near/rounds-check';
import { callArgs, roundsViewer, u128 } from '../lib/near/rounds';
import { handleGuestCreate, handleRelay, type GuestDeps, type RelayDeps } from '../lib/near/routes';
import { parentAccountChain } from '../lib/near/server-chain';
import { WebCryptoSigner } from '../lib/near/signer';
import { memoryNearAccountStore, memoryNearGuestStore } from '../lib/near/store';

const TGAS = 10n ** 12n;
const USDG = 1_000_000n;
const MAX_SPEND = 100_000_000_000_000_000_000_000n; // 0.1 NEAR

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

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const v = await read();
    if (ok(v)) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A keeper call that keeps its transaction hash.
async function keeperCall(keeper: Account, contractId: string, method: string, args: Record<string, unknown>): Promise<{ txHash: string; value: unknown }> {
  const res = await keeper.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, 30n * TGAS, 0n)],
    waitUntil: 'EXECUTED_OPTIMISTIC',
    throwOnFailure: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { txHash: txHashOf(res as any), value: successValue(res as any) };
}

const txs: Array<{ step: string; hash: string }> = [];
function log(step: string, detail = '', hash: string | null = null) {
  if (hash) txs.push({ step, hash });
  console.log(`  ${step.padEnd(26)} ${detail}${hash ? `  tx ${hash}` : ''}`);
}

async function main() {
  const seriesArg = arg('--series');
  const rpcUrl = NEAR_RPC;
  const roundsId = NEAR_ROUNDS || env('NEXT_PUBLIC_BM_NEAR_ROUNDS');
  const parentId = NEAR_PARENT || env('NEXT_PUBLIC_BM_NEAR_PARENT');
  const relayerId = env('BM_NEAR_RELAYER_ACCOUNT');
  if (NEAR_NETWORK !== 'testnet' || !parentId.endsWith('.testnet') || !roundsId.endsWith('.testnet') || /mainnet/.test(rpcUrl)) throw new Error('testnet only');

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const view = roundsViewer({ provider, contractId: roundsId });
  const keeperId = process.env.BM_NEAR_KEEPER_ACCOUNT || 'keeper.atnx.testnet';
  const balances = async () => ({
    parent: await view.nearBalance(parentId),
    relayer: await view.nearBalance(relayerId),
    keeper: await view.nearBalance(keeperId),
    rounds: await view.nearBalance(roundsId),
  });
  const before = await balances();
  console.log(`NEAR guest e2e on ${rpcUrl}: rounds ${roundsId}, parent ${parentId}, relayer ${relayerId}`);

  // ----------------------------------------------------------- the guest
  const relayer = createRelayer({ relayerId, relayerKey: env('BM_NEAR_RELAYER_SECRET'), rpcUrl, policy: roundsRelayPolicy(roundsId, parentId, USER_METHODS) });
  const chain = parentAccountChain({ rpcUrl, parentId, parentKey: env('BM_NEAR_PARENT_SECRET'), roundsId });
  const guests = memoryNearGuestStore();
  // A throwaway salt: this run's hashes live in memory only.
  const salt = randomBytes(32).toString('hex');
  const guestDeps: GuestDeps = {
    store: guests,
    chain,
    parentId,
    hashIp: (ip) => hashIp(salt, ip),
    hasFunds: async () => (await relayer.hasFloat()) && (await chain.spendable()) >= 50_000_000_000_000_000_000_000n,
  };
  const signer = await WebCryptoSigner.generate();
  // As /api/near/guest sees a request from a documentation-range address.
  const client = { ip: '203.0.113.7' };
  const created = await handleGuestCreate(guestDeps, client, { publicKey: signer.publicKeyString });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const accountId = String(created.body.accountId);
  assert.ok(isGuestAccountId(accountId, parentId), `${accountId} is a guest name`);
  log('guest account', `${accountId} (key ${signer.publicKeyString.slice(0, 20)}…)`, String(created.body.txHash));
  const again = await handleGuestCreate(guestDeps, client, { publicKey: signer.publicKeyString });
  assert.equal(again.status, 200, 'a second POST with the same key returns the same account');
  assert.equal(again.body.accountId, accountId);
  const row = [...guests.rows.values()][0];
  assert.match(String(row.ipHash), /^[0-9a-f]{64}$/, 'the row holds the IP hash');
  assert.ok(!JSON.stringify(row).includes(client.ip), 'and never the IP');

  const nearAtStart = await view.nearBalance(accountId);
  log('guest NEAR at start', near(nearAtStart));
  assert.equal(nearAtStart, 0n, 'the guest is created with zero NEAR');
  const keys = await provider.viewAccessKeyList({ accountId });
  assert.equal(keys.keys.length, 1, 'one key, the browser key');
  const key = await provider.viewAccessKey({ accountId, publicKey: PublicKey.from(signer.publicKeyString) });
  const perm = key.permission as { FunctionCall?: { receiver_id: string; method_names: string[] } };
  assert.equal(perm.FunctionCall?.receiver_id, roundsId, 'a function-call key for the rounds contract');
  assert.deepEqual([...(perm.FunctionCall?.method_names ?? [])].sort(), [...USER_METHODS].sort(), 'and the user methods, as a user key');
  log('guest key', `function call on ${roundsId}: ${perm.FunctionCall!.method_names.join(', ')}`);

  // ----------------------------------------------------- the guest relay
  const users = memoryNearAccountStore();
  const relayDeps: RelayDeps = { store: users, guests: { store: guests, parentId }, relayer, appCheck: roundsAppCheck(view) };
  // The browser POSTs { signedDelegate, guest: true } with no cookie: no session.
  const guestFetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.guest, true, 'the guest actor marks its calls');
    const r = await handleRelay(relayDeps, null, body);
    return { status: r.status, json: async () => r.body };
  };
  const { act } = createActor({ accountId, signer, rpcUrl, contractId: roundsId, fetch: guestFetch, guest: true });

  const f = await act('faucet', callArgs.faucet(FAUCET_UNITS));
  assert.equal(f.value, FAUCET_UNITS.toString(), 'faucet returns the amount credited');
  await eventually(() => view.balanceOf(accountId), (b) => b === FAUCET_UNITS, 'the faucet credit');
  log('faucet (guest relay)', `credited ${usdg(u128(f.value))}`, f.txHash);

  // ---------------------------------- refusals that cost nothing, no crossing
  const relayerBefore = await view.nearBalance(relayerId);
  const signFor = (methodName: string, args: Record<string, unknown>) => signCall({ provider, accountId, signer, contractId: roundsId, methodName, args, gas: 30n * TGAS });
  const userBranch = await handleRelay(relayDeps, null, { signedDelegate: (await signFor('faucet', callArgs.faucet(USDG))).signedDelegateBase64 });
  assert.equal(userBranch.body.error, 'signed_out');
  log('refused: user branch', 'no session: signed_out, not sent');
  const alice = { id: '00000000-0000-4000-8000-0000000000e2' };
  await users.insertCreating({ userId: alice.id, accountId: `e2e-alice.${parentId}`, publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString() });
  await users.markActive(alice.id, `e2e-alice.${parentId}`, null);
  const asUser = await handleRelay(relayDeps, alice, { signedDelegate: (await signFor('faucet', callArgs.faucet(USDG))).signedDelegateBase64 });
  assert.equal(asUser.body.error, 'sender_mismatch');
  log('refused: as a user', 'a signed-in user cannot relay the guest: sender_mismatch');
  const withdraw = await guestFetch('/api/near/relay', { method: 'POST', headers: {}, body: JSON.stringify({ signedDelegate: (await signFor('withdraw', callArgs.withdraw(USDG))).signedDelegateBase64, guest: true }) });
  assert.equal(((await withdraw.json()) as { error: string }).error, 'method_not_allowed');
  log('refused: guest withdraw', 'method_not_allowed, not sent');
  const relayerAfterRefusals = await view.nearBalance(relayerId);
  // (A gas refund from the faucet may still land meanwhile: never less.)
  assert.ok((relayerAfterRefusals ?? 0n) >= (relayerBefore ?? 0n), 'the refusals cost the relayer nothing');

  // ---------------------------------------------------------- the series
  let seriesId: number;
  let keeper: Account | null = null;
  if (seriesArg) {
    seriesId = Number(seriesArg);
  } else {
    keeper = new Account(keeperId, provider, new KeyPairSigner(KeyPair.fromString(env('BM_NEAR_KEEPER_SECRET') as KeyPairString)));
    const reference = `e2e9${randomBytes(30).toString('hex')}`;
    const made = await keeperCall(keeper, roundsId, 'create_series', { reference, round_secs: 1_200, settle_window_secs: 300, ante: '0', finder: parentId });
    seriesId = Number(made.value);
    assert.ok(Number.isSafeInteger(seriesId) && seriesId > 0, `create_series returned ${String(made.value)}`);
    log('create_series (keeper)', `series ${seriesId}: 20-minute rounds, not in the registry`, made.txHash);
  }
  const series = await eventually(() => view.series(seriesId), (s) => !!s, 'the series');
  assert.ok(series && series.presaleRound > 0, 'the series has a presale round');
  const presale = series.presaleRound;

  const c = await act('commit', callArgs.commit(seriesId, presale, 'up', 25n * USDG));
  const pos = await eventually(() => view.position(seriesId, presale, accountId), (p) => !!p, 'the commit');
  assert.equal(pos?.presaleUp, 25n * USDG - 250_000n, 'the commit is in the presale pot, net of the 1 % fee');
  assert.equal(c.events.find((e) => e.event === 'commit')?.data.account, accountId);
  log('commit UP 25 (guest relay)', `series ${seriesId} round ${presale}: ${usdg(pos!.presaleUp)} net`, c.txHash);

  // ------------------------------------------------ pause, void, claim back
  if (keeper) {
    const paused = await keeperCall(keeper, roundsId, 'set_series', { series_id: seriesId, paused: true });
    await eventually(() => view.series(seriesId), (s) => !!s?.paused, 'the pause');
    log('set_series paused (keeper)', `series ${seriesId} paused`, paused.txHash);
    const voided = await keeperCall(keeper, roundsId, 'void_round', { series_id: seriesId, round_index: presale });
    await eventually(() => view.round(seriesId, presale), (r) => r?.state === 'void', 'the void');
    // Voiding a paused series' presale round ends the series.
    await eventually(() => view.series(seriesId), (s) => s?.presaleRound === 0, 'the series to end');
    log('void_round (keeper)', `round ${presale} void, series ${seriesId} ended`, voided.txHash);

    const balBefore = await view.balanceOf(accountId);
    const cl = await act('claim', callArgs.claim(seriesId, presale));
    assert.equal(u128(cl.value), pos!.presaleUp, 'a void round refunds the net stake');
    await eventually(() => view.balanceOf(accountId), (b) => b - balBefore === pos!.presaleUp, 'the refund');
    log('claim refund (guest relay)', `refunded ${usdg(u128(cl.value))}`, cl.txHash);
  }

  // --------------------------------------------------------------- totals
  const nearAtEnd = await view.nearBalance(accountId);
  const after = await balances();
  console.log('');
  log('guest NEAR at end', near(nearAtEnd));
  assert.equal(nearAtEnd, 0n, "the guest's NEAR balance stayed 0");
  log('guest USDG', usdg(await view.balanceOf(accountId)));
  const spent = (k: keyof typeof before) => (before[k] ?? 0n) - (after[k] ?? 0n);
  const total = spent('parent') + spent('relayer') + spent('keeper') + spent('rounds');
  console.log(`  spent: parent ${near(spent('parent'))}, relayer ${near(spent('relayer'))}, keeper ${near(spent('keeper'))}, rounds storage ${near(spent('rounds'))}`);
  console.log(`  total ${near(total)}`);
  assert.ok(total < MAX_SPEND, 'under 0.1 NEAR in all');
  console.log('  transactions:');
  for (const t of txs) console.log(`    ${t.step.padEnd(26)} ${t.hash}`);
  console.log('OK');
}

main().catch((e) => {
  if (e instanceof NearActError) console.error(`NearActError ${e.code} (${e.status}): ${e.message}`);
  else console.error(e);
  process.exit(1);
});
