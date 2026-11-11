// One whole house trade on the live site, as a guest, from a terminal, with
// no env file and no wallet:
//
//   npm run house:trade:public
//   npm run house:trade:public -- --market 36 --side down --stake 25
//     --site <url>          default https://atnx-near.vercel.app
//     --market <id>         the market to try first, default 36
//     --side up|down        default up
//     --stake <whole USDG>  default 10 (at 1x)
//     --key-file <path>     default ./.house-trade-key.json, made with mode
//                           600 when missing and reused after, so a rerun is
//                           the same guest
//     --fresh               a new key, so a new guest
//     --rpc <url>           default https://test.rpc.fastnear.com
//
// It does what the browser does. It makes an Ed25519 key (or loads the key
// file's) and POSTs its public key to the site's /api/near/guest, which
// makes the guest's accounts with 0 NEAR and that key as their only key (the
// same key always gets the same account back). Every call after that is a
// NEP-366 delegate this process signs (lib/near/client.ts, the browser's
// code) and POSTs to the site's /api/near/relay with guest: true, which
// relayer.atnx.testnet sends and pays for: a faucet claim if the balance is
// short, a close of any position an interrupted run left open, the order (a
// worst price 1 % past the current price, as the ticket sets it), and its
// close. Then it reads every one of those transactions from public RPC with
// its signer, and the account's NEAR balance and access keys.
//
// An order the contract refuses or refunds moves on to the next market that
// takes orders (list_markets), three markets at most. Every wait gives up
// after 90 s. Exit codes: 0 the whole trade ran and the proof checks out,
// 1 a failure, 2 a bad flag or key file, 3 the site's guest limit was
// reached, 4 no market took the order, 5 a wait timed out, 6 the proof did
// not check out. The secret key is never printed.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KeyPair, type KeyPairString } from 'near-api-js';
import { qualifyingQuote, waitingSince } from '../lib/bm/house-math';
import { trackOutcome, type Tracked, type TrackedOutcome } from '../lib/bm/house-ticket';
import { closeArgs, crankArgs, faucetArgs, openArgs, type HouseClosed, type HouseConfig, type HouseMarket, type HousePosition } from '../lib/bm/house-types';
import { HOUSE_METHOD_GAS, nearTxUrl } from '../lib/near/config';
import { createActor, type NearMethod } from '../lib/near/client';
import { hasHouseKey, houseViewer, type HouseViewer } from '../lib/near/house';
import { rpcTx } from '../lib/near/house-verify';
import {
  EXIT,
  PUBLIC_RELAYER,
  TradeExit,
  USAGE,
  WAIT_MS,
  accountProof,
  closeLimitE2,
  decodeKeyFile,
  encodeKeyFile,
  faucetClaim,
  fmtNear,
  fmtPrice,
  fmtUsdg,
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
  sideWord,
  stakeProblem,
  tooOpen,
  txProof,
  type KeyRecord,
  type TradeOptions,
} from '../lib/near/house-trade';
import { rpcProvider } from '../lib/near/rpc';
import { WebCryptoSigner } from '../lib/near/signer';
import type { FetchFn } from '../lib/near/verify';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const say = (line: string) => console.log(line);
const POLL_MS = 2_000;
// A relayed call can take the route its whole 60 s.
const RELAY_TIMEOUT_MS = 75_000;
// When a fill or a close is still waiting this long with a quote on chain to
// settle at, the run cranks the position itself (anyone may).
const CRANK_AFTER_MS = 30_000;

const timedFetch =
  (ms: number): FetchFn =>
  (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

// ------------------------------------------------------------- the key

function saveKeyFile(path: string, r: KeyRecord): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, encodeKeyFile(r), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw new TradeExit(EXIT.usage, `${path}: could not be written (${(err as NodeJS.ErrnoException)?.code ?? 'error'})`);
  }
}

function loadOrMakeKey(path: string, fresh: boolean): { record: KeyRecord; line: string } {
  if (!fresh && existsSync(path)) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new TradeExit(EXIT.usage, `${path}: could not be read (${(err as NodeJS.ErrnoException)?.code ?? 'error'})`);
    }
    const record = decodeKeyFile(text, path);
    let mode = '';
    try {
      if (tooOpen(statSync(path).mode)) {
        chmodSync(path, 0o600);
        mode = ', its mode set to 600';
      }
    } catch {
      /* the mode stays as it is */
    }
    return { record, line: `the key ${record.publicKey} from ${path}${mode}` };
  }
  const replaced = existsSync(path);
  const record = newKeyRecord();
  saveKeyFile(path, record);
  return { record, line: `a new Ed25519 key ${record.publicKey}, saved to ${path} (mode 600)${replaced ? ', replacing the key that was there' : ''}` };
}

// ----------------------------------------------------------- the guest

interface Guest {
  accountId: string;
  houseAccountId: string;
  created: boolean;
  houseCreated: boolean;
  txHash: string | null;
  houseTxHash: string | null;
}

// POST { publicKey } to /api/near/guest with no cookie, as the browser does
// (components/rounds/useNearAccount.ts setUpGuest), waiting while another
// request for the same key is still making it.
async function askGuest(site: string, publicKey: string): Promise<Guest> {
  const post = timedFetch(70_000);
  let gatewayRetried = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    let status: number;
    let body: Record<string, unknown>;
    try {
      const res = await post(`${site}/api/near/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey }) });
      status = res.status;
      body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    } catch (err) {
      if (!gatewayRetried) {
        gatewayRetried = true;
        say(`   the site did not answer (${String((err as Error)?.message ?? err).slice(0, 80)}); asking again in 5 s`);
        await sleep(5_000);
        continue;
      }
      throw new TradeExit(EXIT.failed, `The site did not answer at ${site}/api/near/guest.`);
    }
    if ((status === 200 || status === 201) && typeof body.accountId === 'string') {
      if (typeof body.houseAccountId !== 'string') throw new TradeExit(EXIT.failed, `The site made the guest ${body.accountId} but no house account: is ${site} the house build?`);
      const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : null);
      return { accountId: body.accountId, houseAccountId: body.houseAccountId, created: body.created === true, houseCreated: body.houseCreated === true, txHash: s('txHash'), houseTxHash: s('houseTxHash') };
    }
    if (status === 409 && body.error === 'in_progress') {
      await sleep(POLL_MS);
      continue;
    }
    // A gateway's answer, not the route's: once more after a pause.
    if (status >= 500 && typeof body.error !== 'string' && !gatewayRetried) {
      gatewayRetried = true;
      say(`   the site answered HTTP ${status}; asking again in 5 s`);
      await sleep(5_000);
      continue;
    }
    throw guestRefusal(status, body);
  }
  throw guestRefusal(409, { error: 'in_progress' });
}

// ------------------------------------------------------------ the trade

interface SentTx {
  label: string;
  method: NearMethod;
  hash: string | null;
}

class Trader {
  readonly txs: SentTx[] = [];
  private readonly act: ReturnType<typeof createActor>['act'];

  constructor(
    readonly opts: TradeOptions,
    readonly view: HouseViewer,
    readonly cfg: HouseConfig,
    readonly account: string,
    signer: WebCryptoSigner,
  ) {
    const relayFetch = timedFetch(RELAY_TIMEOUT_MS);
    this.act = createActor({
      accountId: account,
      signer,
      rpcUrl: opts.rpc,
      contractId: opts.contract,
      endpoint: `${opts.site}/api/near/relay`,
      fetch: (url, init) => relayFetch(url, init),
      guest: true,
      gas: HOUSE_METHOD_GAS,
    }).act;
  }

  // One relayed call. An answer that says nothing was sent is tried again
  // once, 5 s later; one that leaves it open is looked for first (`landed`
  // returns the call's value once its effect shows), then tried again once.
  async relay(label: string, method: NearMethod, args: Record<string, unknown>, landed: () => Promise<unknown | null>): Promise<{ hash: string | null; value: unknown }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.act(method, args);
        this.txs.push({ label, method, hash: r.txHash });
        return { hash: r.txHash, value: r.value };
      } catch (err) {
        const kind = relayErrorKind(err);
        if (attempt > 0 || kind === 'refused') throw err;
        if (kind === 'retry') {
          say(`   the relay answered ${relayErrorLine(err)}, so nothing was sent; sending it again in 5 s`);
          await sleep(5_000);
          continue;
        }
        say(`   the relay answered ${relayErrorLine(err)}, so the call may still go through; looking before sending it again`);
        for (let i = 0; i < 4; i++) {
          await sleep(5_000);
          const v = await landed().catch(() => null);
          if (v !== null) {
            this.txs.push({ label, method, hash: null });
            return { hash: null, value: v };
          }
        }
        say('   it did not go through; sending it again');
      }
    }
  }

  // The position's account's history and the market, read together.
  private async read(id: bigint, market: number): Promise<{ position: HousePosition | null; history: HouseClosed[]; market: HouseMarket | null }> {
    const [position, history, m] = await Promise.all([this.view.position(id), this.view.historyOf(this.account), this.view.market(market)]);
    return { position, history, market: m };
  }

  // Follows an order or a close until it resolves (trackOutcome, as the
  // ticket follows it), cranking it once if it waits with a quote to
  // settle at on chain.
  async follow(t: Tracked, market: number, what: string): Promise<Exclude<TrackedOutcome, { phase: 'waiting' }>> {
    const deadline = t.sentAtMs + WAIT_MS;
    let cranked = false;
    for (;;) {
      const now = await this.read(t.id, market);
      if (now.position) {
        if (now.position.state === 'Closing') t.sawClosing = true;
        t.last = now.position;
      }
      const out = trackOutcome(t, now, this.cfg, Date.now());
      if (out.phase !== 'waiting') return out;
      if (Date.now() > deadline) {
        throw new TradeExit(EXIT.timeout, `Timed out after ${WAIT_MS / 1000} s waiting for ${what} (position ${t.id} is ${now.position?.state ?? 'not readable'}). The keeper's next quote settles it; a rerun with the same key file closes it first.`);
      }
      const p = now.position;
      if (!cranked && p && now.market && Date.now() - t.sentAtMs > CRANK_AFTER_MS && qualifyingQuote(now.market, waitingSince(p) + this.cfg.minFillDelaySecs)) {
        cranked = true;
        say(`   still waiting after ${CRANK_AFTER_MS / 1000} s with a quote to settle at on chain: cranking position ${p.id} through the relay`);
        await this.relay('crank', 'crank', crankArgs([p.id]), async () => null).catch((err) => say(`   the crank did not go through (${relayErrorLine(err)}); waiting for the keeper`));
      }
      await sleep(POLL_MS);
    }
  }

  // Closes an open position at 1 % past the price it would close at now,
  // asking again (at most three times in all) when the price moves past
  // that before the close settles. Returns its history entry.
  async close(p: HousePosition, prefix: string): Promise<HouseClosed | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const market = await this.view.market(p.market);
      const lim = closeLimitE2({ cfg: this.cfg, market, side: p.side });
      if (!lim) throw new TradeExit(EXIT.failed, `Market ${p.market} has no price to close position ${p.id} at.`);
      const sent = await this.relay('close', 'close', closeArgs(p.id, lim.limitE2), async () => {
        const x = await this.view.position(p.id);
        return !x || x.state === 'Closing' ? String(p.id) : null;
      });
      say(`${prefix}position ${p.id} at a worst price of ${fmtPrice(lim.limitE2)} (${p.side === 'Long' ? 'sell' : 'buy'} price ${fmtPrice(lim.exitE2)}): requested${txNote(sent.hash)}`);
      const out = await this.follow({ id: p.id, kind: 'close', sentAtMs: Date.now(), last: null }, p.market, `position ${p.id} to close`);
      if (out.phase === 'closed') return out.closed ?? (await this.historyEntry(p.id));
      if (out.phase === 'close_missed') {
        say('   the price moved past the worst price before the close settled, so the position is open again; asking again');
        p = (await this.view.position(p.id)) ?? p;
        continue;
      }
      throw new TradeExit(EXIT.failed, `Position ${p.id}'s close ended as ${out.phase}.`);
    }
    throw new TradeExit(EXIT.failed, `Position ${p.id}'s close missed its worst price three times; it is still open. Rerun to try again.`);
  }

  async historyEntry(id: bigint): Promise<HouseClosed | null> {
    for (let i = 0; i < 5; i++) {
      const h = (await this.view.historyOf(this.account)).find((c) => c.id === id);
      if (h) return h;
      await sleep(POLL_MS);
    }
    return null;
  }
}

const txNote = (hash: string | null) => (hash ? ` (tx ${hash})` : ' (tx hash unknown: the relay could not confirm the send)');

function closedLine(c: HouseClosed | null): string {
  if (!c) return 'Closed (its payout is not in the history yet)';
  const pnl = c.payout - c.stake;
  return `${c.reason === 'close' ? 'Closed' : `Closed (${c.reason})`} at ${fmtPrice(c.exitE2)}: payout ${fmtUsdg(c.payout)} USDG for a stake of ${fmtUsdg(c.stake)} (${pnl >= 0n ? '+' : ''}${fmtUsdg(pnl)} USDG)`;
}

async function listAll(view: HouseViewer): Promise<HouseMarket[]> {
  const out: HouseMarket[] = [];
  for (let from = 0; from < 100_000; from += 100) {
    const page = await view.listMarkets(from, 100);
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

// --------------------------------------------------------------- proof

async function rpcQuery(fetchFn: FetchFn, rpcUrl: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetchFn(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'atnx-trade', method: 'query', params }) });
  if (!res.ok) throw new Error(`the RPC answered HTTP ${res.status}`);
  const body = (await res.json()) as { error?: unknown; result?: unknown };
  if (body.error) throw new Error(`RPC error ${JSON.stringify(body.error).slice(0, 200)}`);
  return body.result;
}

async function twice<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await sleep(3_000);
    return fn();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const opts = parseTradeArgs(process.argv.slice(2));
  if (opts.help) {
    say(USAGE);
    return EXIT.ok;
  }
  const keyPath = resolve(process.cwd(), opts.keyFile);
  const provider = rpcProvider(opts.rpc);
  const view = houseViewer({ provider, contractId: opts.contract });
  const side = sideWord(opts.side);
  say(`House trade on ${opts.site} as a guest: contract ${opts.contract}, RPC ${opts.rpc}`);

  // 1. The key.
  const key = loadOrMakeKey(keyPath, opts.fresh);
  say(`1. Key: ${key.line}`);
  const signer = await WebCryptoSigner.fromKeyPair(KeyPair.fromString(key.record.secretKey as KeyPairString));

  // 2. The guest, from the site.
  const guest = await askGuest(opts.site, key.record.publicKey);
  const account = guest.houseAccountId;
  if (key.record.houseAccountId && key.record.houseAccountId !== account) say(`   (the key file named ${key.record.houseAccountId}; the site answered ${account}, which is used)`);
  if (key.record.houseAccountId !== account || key.record.accountId !== guest.accountId || key.record.site !== opts.site) {
    saveKeyFile(keyPath, { ...key.record, accountId: guest.accountId, houseAccountId: account, site: opts.site });
  }
  say(
    guest.created || guest.houseCreated
      ? `2. Guest: ${account} (the house account of ${guest.accountId}), made just now by the site with this key as its only key (tx ${guest.houseTxHash ?? 'unknown'})`
      : `2. Guest: ${account} (the house account of ${guest.accountId}), the one the site already had for this key: no new guest was made`,
  );

  // Signing reads the key's nonce, and the RPC can trail the site's
  // creation by a moment.
  const keyDeadline = Date.now() + 30_000;
  while (!(await hasHouseKey(provider, account, key.record.publicKey, opts.contract).catch(() => false))) {
    if (Date.now() > keyDeadline) throw new TradeExit(EXIT.timeout, `Timed out after 30 s waiting for ${opts.rpc} to show this key on ${account} as a key for ${opts.contract}.`);
    await sleep(POLL_MS);
  }

  const cfg = await view.config();
  const bad = stakeProblem(opts.stake, cfg);
  if (bad) throw new TradeExit(EXIT.usage, bad);
  const trader = new Trader(opts, view, cfg, account, signer);

  // 3. Test USDG, only as much as the order needs.
  const need = orderCost(opts.stake, cfg);
  const [balance, claimed] = await Promise.all([view.balanceOf(account), view.faucetClaimed(account)]);
  const claim = faucetClaim({ balance, need, claimed, cap: cfg.faucetPerAccount });
  if (claim === null) {
    say(`3. Funds: ${fmtUsdg(balance)} USDG in the contract covers the order's ${fmtUsdg(need)} (stake and fee): no faucet claim`);
  } else {
    const sent = await trader.relay('faucet', 'faucet', faucetArgs(claim), async () => ((await view.balanceOf(account)) >= balance + claim ? claim.toString() : null));
    const deadline = Date.now() + WAIT_MS;
    let now = await view.balanceOf(account);
    while (now < balance + claim) {
      if (Date.now() > deadline) throw new TradeExit(EXIT.timeout, `Timed out after ${WAIT_MS / 1000} s waiting for the faucet's ${fmtUsdg(claim)} USDG to show in the balance.`);
      await sleep(POLL_MS);
      now = await view.balanceOf(account);
    }
    say(`3. Funds: ${fmtUsdg(balance)} USDG did not cover the order's ${fmtUsdg(need)}: claimed ${fmtUsdg(claim)} test USDG from the faucet, balance now ${fmtUsdg(now)}${txNote(sent.hash)}`);
  }

  // 4. Whatever an interrupted run left open.
  const left = await view.positionsOf(account);
  if (left.length === 0) say('4. Earlier positions: none open');
  for (const p0 of left) {
    let p: HousePosition | null = p0;
    say(`4. Earlier position ${p.id} (market ${p.market}, ${sideWord(p.side)} ${p.leverage}x, ${fmtUsdg(p.stake)} USDG) is ${p.state}: settling it first`);
    if (p.state === 'Pending') {
      const out = await trader.follow({ id: p.id, kind: 'open', sentAtMs: Date.now(), last: p }, p.market, `earlier order ${p.id} to fill or be refunded`);
      if (out.phase === 'refunded') {
        say(`   refunded: ${refundMessage(out.reason)}`);
        continue;
      }
      if (out.phase === 'closed') {
        say(`   ${closedLine(out.closed)}`);
        continue;
      }
      p = await view.position(p.id);
    }
    if (p && p.state === 'Closing') {
      const out = await trader.follow({ id: p.id, kind: 'close', sentAtMs: Date.now(), last: p, sawClosing: true }, p.market, `earlier position ${p.id} to close`);
      if (out.phase === 'closed') {
        say(`   ${closedLine(out.closed ?? (await trader.historyEntry(p.id)))}`);
        continue;
      }
      p = await view.position(p.id);
    }
    if (p && p.state === 'Open') say(`   ${closedLine(await trader.close(p, '   Close: '))}`);
  }

  // 5. The order: the asked-for market first, then the next that take orders.
  const tries = marketsToTry(opts.market, await listAll(view));
  const reasons: string[] = [];
  let filled: { id: bigint; market: number; entryE2: bigint } | null = null;
  let closedEarly: HouseClosed | null = null;
  for (const id of tries) {
    const m = await view.market(id);
    if (!m) {
      reasons.push(`market ${id}: no such market`);
      say(`5. Market ${id}: not listed on ${opts.contract}`);
      continue;
    }
    // open's own checks, run by the contract on its newest quote.
    const q = await view.quoteOpen({ market: id, side: opts.side, leverage: opts.leverage, stake: opts.stake });
    const refusal = q && !q.allowed ? (q.reason ?? 'refused') : q && q.wouldFill === false ? (q.fillReason ?? 'it would not fill now') : null;
    if (refusal) {
      reasons.push(`market ${id}: ${refusal}`);
      say(`5. Market ${id} takes no order now, the contract says: ${refusal}`);
      if (q && !q.allowed && !isMarketRefusal(q.reason)) throw new TradeExit(EXIT.failed, `The contract refuses this order on any market: ${refusal}.`);
      continue;
    }
    const lim = orderLimitE2({ cfg, market: m, side: opts.side, leverage: opts.leverage, stake: opts.stake });
    if (!lim) {
      reasons.push(`market ${id}: no price`);
      say(`5. Market ${id}: no price on chain`);
      continue;
    }
    const before = new Set((await view.positionsOf(account)).map((p) => p.id));
    let sent: { hash: string | null; value: unknown };
    try {
      sent = await trader.relay('open', 'open', openArgs({ market: id, side: opts.side, leverage: opts.leverage, stake: opts.stake, limitE2: lim.limitE2 }), async () => {
        const fresh = (await view.positionsOf(account)).find((p) => !before.has(p.id) && p.market === id);
        return fresh ? fresh.id.toString() : null;
      });
    } catch (err) {
      const r = openRefusal(err);
      reasons.push(`market ${id}: ${r.reason}`);
      say(`5. Market ${id} refused the order: ${r.reason}`);
      if (r.kind === 'stop') throw new TradeExit(EXIT.failed, `The order was refused: ${r.reason}.`);
      continue;
    }
    const posId = typeof sent.value === 'string' && /^\d+$/.test(sent.value) ? BigInt(sent.value) : typeof sent.value === 'number' ? BigInt(sent.value) : null;
    if (posId === null) throw new TradeExit(EXIT.failed, `open returned ${JSON.stringify(sent.value)}, not a position id.`);
    say(
      `5. Order: market ${id}, ${side} ${opts.leverage}x, ${fmtUsdg(opts.stake)} USDG at a worst price of ${fmtPrice(lim.limitE2)} (${opts.side === 'Long' ? 'buy' : 'sell'} price ${fmtPrice(lim.entryE2)}): placed as position ${posId}${txNote(sent.hash)}; waiting for the keeper's next quote`,
    );
    const out = await trader.follow({ id: posId, kind: 'open', sentAtMs: Date.now(), last: null }, id, `order ${posId} on market ${id} to fill`);
    if (out.phase === 'filled') {
      say(`   Filled at ${fmtPrice(out.entryE2)}`);
      filled = { id: posId, market: id, entryE2: out.entryE2 };
      break;
    }
    if (out.phase === 'closed') {
      // Filled and ended at once (the cap, say): there is nothing to close.
      say(`   Filled at ${fmtPrice(out.closed?.entryE2 ?? 0n)}, then ${closedLine(out.closed)}`);
      filled = { id: posId, market: id, entryE2: out.closed?.entryE2 ?? 0n };
      closedEarly = out.closed;
      break;
    }
    const why = out.phase === 'refunded' ? refundMessage(out.reason) : out.phase;
    reasons.push(`market ${id}: ${why}`);
    say(`   Refunded instead of filled: ${why}`);
  }
  if (!filled) throw new TradeExit(EXIT.noMarket, `No market took the order (${tries.length} tried): ${reasons.join('; ')}.`);

  // 6. The close.
  if (!closedEarly) {
    const p = await view.position(filled.id);
    if (!p) {
      say(`6. ${closedLine(await trader.historyEntry(filled.id))}`);
    } else {
      const closed = await trader.close(p, '6. Close: ');
      say(`   ${closedLine(closed)}`);
    }
  }

  // 7. The proof, from public RPC.
  say(`7. Proof, read from ${opts.rpc}:`);
  const read = timedFetch(30_000);
  const problems: string[] = [];
  for (const t of trader.txs) {
    if (!t.hash) {
      say(`   ${t.label.padEnd(7)} (no hash: the relay could not confirm the send)`);
      continue;
    }
    try {
      const res = await twice(() => rpcTx(read, opts.rpc, t.hash!, PUBLIC_RELAYER));
      const p = txProof(t.hash, res, { relayer: PUBLIC_RELAYER, sender: account, contract: opts.contract, method: t.method });
      say(`   ${t.label.padEnd(7)} ${t.hash}  signer ${p.signer}, a Delegate from ${p.sender} calling ${p.method} on ${p.receiver}${p.succeeded ? '' : ', FAILED'}`);
      say(`           ${nearTxUrl(t.hash)}`);
      problems.push(...p.problems.map((x) => `${t.label} ${t.hash}: ${x}`));
    } catch (err) {
      problems.push(`${t.label} ${t.hash}: not readable as a transaction signed by ${PUBLIC_RELAYER} (${String((err as Error)?.message ?? err).slice(0, 120)})`);
      say(`   ${t.label.padEnd(7)} ${t.hash}  not readable from the RPC`);
    }
  }
  const [acct, keys] = await Promise.all([
    twice(() => rpcQuery(read, opts.rpc, { request_type: 'view_account', finality: 'final', account_id: account })),
    twice(() => rpcQuery(read, opts.rpc, { request_type: 'view_access_key_list', finality: 'final', account_id: account })),
  ]);
  const ap = accountProof(acct, keys, { publicKey: key.record.publicKey, contract: opts.contract });
  say(`   ${account} holds ${ap.amount === null ? 'an amount of NEAR the RPC did not show' : fmtNear(ap.amount)}`);
  say(`   its access keys (${ap.keys.length}): ${ap.keys.join('; ') || 'none'}`);
  problems.push(...ap.problems.map((x) => `${account}: ${x}`));
  const left2 = await view.positionsOf(account);
  if (left2.length > 0) problems.push(`${account} still has ${left2.length} pending, open or closing position(s): ${left2.map((p) => `${p.id} ${p.state}`).join(', ')}`);

  if (problems.length > 0) {
    say('MISMATCH:');
    for (const p of problems) say(`  - ${p}`);
    return EXIT.proof;
  }
  say(`OK: ${account}, a guest with 0 NEAR whose only key is a function-call key for ${opts.contract}, opened and closed a position; ${PUBLIC_RELAYER} signed and paid for every call.`);
  return EXIT.ok;
}

process.on('SIGINT', () => {
  console.error('\nInterrupted. A position this run opened may still be open: rerun with the same key file and it is closed first.');
  process.exit(EXIT.failed);
});

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof TradeExit) {
      console.error(err.message);
      process.exitCode = err.code;
      return;
    }
    console.error(`Failed: ${relayErrorLine(err)}`);
    process.exitCode = EXIT.failed;
  },
);
