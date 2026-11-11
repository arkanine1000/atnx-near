// The pure parts of scripts/house-trade-public.ts, the one command that
// trades on the live site as a guest from a terminal: its flags, its key
// file, the order's worst price and the faucet claim it needs, which
// markets it tries, what the site's, the relay's and the contract's
// refusals mean and which exit code each one gets, and the checks on what
// the public RPC shows afterwards. No network and no file system here: the
// script does the I/O, and lib/near/house-trade.test.ts tests the rest.
import { KeyPair, baseDecode, type KeyPairString } from 'near-api-js';
import { closePrice, feeOf, newestQuote, quotePrices } from '../bm/house-math';
import { CONTRACT_MESSAGE, limitPastE2, refundLine, ticketNumbers, type RefundReason } from '../bm/house-ticket';
import type { HouseConfig, HouseMarket, HouseSide } from '../bm/house-types';
import { NearActError } from './client';
import { GUEST_CAPS } from './guest';
import { PUBLIC_HOUSE_CONTRACT } from './house-verify';
import { PUBLIC_RPC, PUBLIC_SITE } from './verify';

export const USDG = 1_000_000n;
export const PUBLIC_RELAYER = 'relayer.atnx.testnet';
export const DEFAULT_KEY_FILE = '.house-trade-key.json';

// What the faucet is asked for: the shortfall rounded up to this step, so
// a first run claims 50 USDG and never the 10,000 the contract allows.
export const FAUCET_STEP = 50n * USDG;
// Every wait gives up after this long (a fill or a close normally takes
// about 10 seconds).
export const WAIT_MS = 90_000;
// At most this many markets are tried before the run gives up.
export const MAX_MARKETS = 3;

export const EXIT = {
  ok: 0, // the whole trade ran and the proof checks out
  failed: 1, // anything else: the site, the relay or the RPC failed
  usage: 2, // a bad flag or an unreadable key file
  guestLimit: 3, // the site's guest limit was reached
  noMarket: 4, // no market took the order
  timeout: 5, // a wait timed out
  proof: 6, // the public RPC does not show what it should
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// A failure the script reports in one line and exits with.
export class TradeExit extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
  ) {
    super(message);
    this.name = 'TradeExit';
  }
}

// ---------------------------------------------------------------- flags

export interface TradeOptions {
  site: string;
  rpc: string;
  contract: string;
  market: number;
  side: HouseSide;
  leverage: 1;
  stake: bigint;
  keyFile: string;
  fresh: boolean;
  help: boolean;
}

export const DEFAULT_OPTIONS: TradeOptions = {
  site: PUBLIC_SITE,
  rpc: PUBLIC_RPC,
  contract: PUBLIC_HOUSE_CONTRACT,
  market: 36,
  side: 'Long',
  leverage: 1,
  stake: 10n * USDG,
  keyFile: DEFAULT_KEY_FILE,
  fresh: false,
  help: false,
};

export const USAGE = `usage: npm run house:trade:public -- [flags]

Makes (or reuses) a guest account on the live site, gets test USDG from the
faucet if it needs any, opens a 1x position, closes it, and prints proof
from public RPC. Needs no env file.

  --site <url>          default ${PUBLIC_SITE}
  --market <id>         the house market to try first, default ${DEFAULT_OPTIONS.market}
  --side up|down        default up
  --stake <whole USDG>  default ${DEFAULT_OPTIONS.stake / USDG}
  --key-file <path>     default ./${DEFAULT_KEY_FILE}; made (mode 600) if missing,
                        and reused next time, so a rerun trades as the same guest
  --fresh               make a new key (and so a new guest) in the key file
  --rpc <url>           default ${PUBLIC_RPC}

Exit codes: 0 the whole trade ran, 1 a failure, 2 a bad flag or key file,
3 the site's guest limit was reached, 4 no market took the order,
5 a wait timed out, 6 the proof did not check out.`;

function httpUrl(v: string, flag: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new TradeExit(EXIT.usage, `${flag} must be a URL, got ${JSON.stringify(v)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TradeExit(EXIT.usage, `${flag} must be an http(s) URL`);
  return v.replace(/\/+$/, '');
}

// argv without the node and script paths. Throws TradeExit(usage).
export function parseTradeArgs(argv: readonly string[]): TradeOptions {
  const o: TradeOptions = { ...DEFAULT_OPTIONS };
  const takesValue = new Set(['--site', '--market', '--side', '--stake', '--key-file', '--rpc']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      o.help = true;
      continue;
    }
    if (a === '--fresh') {
      o.fresh = true;
      continue;
    }
    if (!takesValue.has(a)) throw new TradeExit(EXIT.usage, a.startsWith('-') ? `unknown flag ${a}` : `unexpected argument ${JSON.stringify(a)}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new TradeExit(EXIT.usage, `${a} needs a value`);
    i++;
    switch (a) {
      case '--site':
        o.site = httpUrl(v, a);
        break;
      case '--rpc':
        o.rpc = httpUrl(v, a);
        break;
      case '--market':
        if (!/^\d{1,9}$/.test(v)) throw new TradeExit(EXIT.usage, `--market must be a market id (a whole number), got ${JSON.stringify(v)}`);
        o.market = Number(v);
        break;
      case '--side': {
        const s = v.toLowerCase();
        if (s !== 'up' && s !== 'down') throw new TradeExit(EXIT.usage, `--side must be up or down, got ${JSON.stringify(v)}`);
        o.side = s === 'up' ? 'Long' : 'Short';
        break;
      }
      case '--stake':
        if (!/^\d{1,7}$/.test(v) || BigInt(v) === 0n) throw new TradeExit(EXIT.usage, `--stake must be a whole number of USDG, got ${JSON.stringify(v)}`);
        o.stake = BigInt(v) * USDG;
        break;
      case '--key-file':
        if (!v.trim()) throw new TradeExit(EXIT.usage, '--key-file needs a path');
        o.keyFile = v;
        break;
    }
  }
  return o;
}

// The stake against the contract's limits, in its words.
export function stakeProblem(stake: bigint, cfg: Pick<HouseConfig, 'minStake' | 'maxStake'>): string | null {
  const min = cfg.minStake;
  const max = cfg.maxStake;
  if ((min !== null && stake < min) || (max !== null && stake > max)) {
    return `--stake ${fmtUsdg(stake)} is outside what the contract takes: ${min !== null ? fmtUsdg(min) : '0'} to ${max !== null ? fmtUsdg(max) : 'any'} USDG`;
  }
  return null;
}

// ------------------------------------------------------------- key file

// What the key file holds. The secret key never leaves it: nothing the
// script prints or throws contains it.
export interface KeyRecord {
  publicKey: string;
  secretKey: string;
  // What the site made for this key, once it has (informational: the guest
  // route is asked again on every run and its answer wins).
  accountId?: string;
  houseAccountId?: string;
  site?: string;
  createdAt?: string;
}

export function newKeyRecord(now: Date = new Date()): KeyRecord {
  const kp = KeyPair.fromRandom('ed25519');
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString(), createdAt: now.toISOString() };
}

export function encodeKeyFile(r: KeyRecord): string {
  const out: Record<string, string> = {
    note: 'A NEAR testnet guest key made by npm run house:trade:public. It is the only key of the guest account below; keep it private.',
    publicKey: r.publicKey,
    secretKey: r.secretKey,
  };
  if (r.accountId) out.accountId = r.accountId;
  if (r.houseAccountId) out.houseAccountId = r.houseAccountId;
  if (r.site) out.site = r.site;
  if (r.createdAt) out.createdAt = r.createdAt;
  return `${JSON.stringify(out, null, 2)}\n`;
}

const ED25519_SECRET = /^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/;

// The key file's text, checked. Every error names the file's problem and
// never echoes its content (a JSON.parse message would quote it).
export function decodeKeyFile(text: string, path: string): KeyRecord {
  const bad = (why: string) => new TradeExit(EXIT.usage, `${path}: ${why}. Move it away or pass --fresh to make a new key there.`);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad('not valid JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('expected a JSON object');
  const o = v as Record<string, unknown>;
  if (typeof o.secretKey !== 'string' || !ED25519_SECRET.test(o.secretKey)) throw bad('no ed25519 secretKey in it');
  // 64 bytes, the seed and then the public key it makes, as near-api-js
  // writes an ed25519 secret key.
  let publicKey: string;
  try {
    const bytes = baseDecode(o.secretKey.slice('ed25519:'.length));
    const kp = KeyPair.fromString(o.secretKey as KeyPairString);
    const pub = kp.getPublicKey();
    if (bytes.length !== 64 || !bytes.slice(32).every((b, i) => b === pub.data[i])) throw new Error('inconsistent');
    publicKey = pub.toString();
  } catch {
    throw bad('its secretKey is not a usable ed25519 key');
  }
  if (o.publicKey !== undefined && o.publicKey !== publicKey) throw bad('its publicKey does not belong to its secretKey');
  const str = (k: string) => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : undefined);
  return { publicKey, secretKey: o.secretKey, accountId: str('accountId'), houseAccountId: str('houseAccountId'), site: str('site'), createdAt: str('createdAt') };
}

// A key file anyone but its owner may read (mode bits).
export const tooOpen = (mode: number) => (mode & 0o077) !== 0;

// ---------------------------------------------------------- the numbers

// Exact, at least two decimals, no trailing zeros past them: 10.1 USDG →
// "10.10", 9.956123 → "9.956123", 10,000 → "10,000.00".
export function fmtUsdg(units: bigint): string {
  const neg = units < 0n;
  const a = neg ? -units : units;
  const whole = (a / USDG).toLocaleString('en-US');
  let frac = (a % USDG).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// A price in hundredths: "1,162.21".
export function fmtPrice(e2: bigint): string {
  const whole = (e2 / 100n).toLocaleString('en-US');
  return `${whole}.${(e2 % 100n).toString().padStart(2, '0')}`;
}

export const sideWord = (s: HouseSide) => (s === 'Long' ? 'UP' : 'DOWN');

// What the order debits: the stake and its fee.
export function orderCost(stake: bigint, cfg: Pick<HouseConfig, 'feeBps'>): bigint {
  return stake + feeOf(stake, cfg.feeBps ?? 100);
}

// How much to claim from the faucet so the balance covers `need`: null
// when it already does; the shortfall rounded up to FAUCET_STEP, within
// what the faucet still gives this account. Throws when it gives too
// little.
export function faucetClaim(a: { balance: bigint; need: bigint; claimed: bigint | null; cap: bigint | null; step?: bigint }): bigint | null {
  if (a.balance >= a.need) return null;
  const step = a.step ?? FAUCET_STEP;
  const short = a.need - a.balance;
  let amount = ((short + step - 1n) / step) * step;
  if (a.cap !== null) {
    const left = a.cap - (a.claimed ?? 0n);
    if (left < short) {
      throw new TradeExit(EXIT.failed, `The balance is ${fmtUsdg(a.balance)} USDG, the order needs ${fmtUsdg(a.need)}, and the faucet has only ${fmtUsdg(left > 0n ? left : 0n)} USDG left for this account. Rerun with --fresh for a new guest.`);
    }
    if (amount > left) amount = left;
  }
  return amount;
}

// The worst price an order accepts: 1 % past where it would fill at the
// market's newest quote, as the ticket fills it in (limitPastE2 on
// ticketNumbers' entry). Null when the market has no price.
export function orderLimitE2(a: { cfg: Pick<HouseConfig, 'leadMinBps' | 'leadFullGapBps' | 'feeBps' | 'maxProfitBps'>; market: HouseMarket; side: HouseSide; leverage: number; stake: bigint }): { entryE2: bigint; limitE2: bigint } | null {
  const q = newestQuote(a.market);
  if (!q) return null;
  const n = ticketNumbers({ cfg: a.cfg, quote: q, side: a.side, leverage: a.leverage, stake: a.stake });
  if (n.entryE2 <= 0n) return null;
  return { entryE2: n.entryE2, limitE2: limitPastE2(n.entryE2, a.side, 'open') };
}

// The worst exit a close accepts: 1 % past the price it would close at
// now, as the portfolio's Close button sends it. Null with no price.
export function closeLimitE2(a: { cfg: Pick<HouseConfig, 'leadMinBps' | 'leadFullGapBps'>; market: HouseMarket | null; side: HouseSide }): { exitE2: bigint; limitE2: bigint } | null {
  const q = a.market ? newestQuote(a.market) : null;
  if (!q) return null;
  const exit = closePrice(quotePrices(q.scoreE2, q.readingE2, a.cfg), a.side);
  if (exit <= 0n) return null;
  return { exitE2: exit, limitE2: limitPastE2(exit, a.side, 'close') };
}

// The markets to try, at most MAX_MARKETS: the one asked for first, then
// the listed markets that take orders now (list_markets' `opens`), the ids
// after it first, then the ones before it.
export function marketsToTry(requested: number, markets: readonly Pick<HouseMarket, 'id' | 'status' | 'opens'>[], max: number = MAX_MARKETS): number[] {
  const takes = markets.filter((m) => m.id !== requested && m.status === 'Open' && m.opens !== false);
  const after = takes.filter((m) => m.id > requested).sort((a, b) => a.id - b.id);
  const before = takes.filter((m) => m.id < requested).sort((a, b) => a.id - b.id);
  return [requested, ...[...after, ...before].map((m) => m.id)].slice(0, max);
}

// --------------------------------------------------------- the refusals

// Durations as the messages say them: 3600 → "an hour".
export function fmtWindow(secs: number): string {
  if (secs === 3_600) return 'an hour';
  if (secs % 86_400 === 0) return secs === 86_400 ? '24 hours' : `${secs / 86_400} days`;
  if (secs % 3_600 === 0) return `${secs / 3_600} hours`;
  return `${Math.round(secs / 60)} minutes`;
}

// What a refusal from /api/near/guest means (its codes are in
// app/api/near/guest/route.ts).
export function guestRefusal(status: number, body: Record<string, unknown>, caps = GUEST_CAPS): TradeExit {
  const code = typeof body.error === 'string' ? body.error : `http_${status}`;
  const rerun = 'or rerun now with --key-file pointing at a key file that already has a guest account, which needs no new one.';
  const ipWindow = fmtWindow(caps.ipWindowSecs).replace(/^an /, '');
  switch (code) {
    case 'guest_limit_ip':
      return new TradeExit(
        EXIT.guestLimit,
        `The site's per-network limit on new guest accounts was reached; it counts over a rolling ${ipWindow}, so rerun later (at most ${fmtWindow(caps.ipWindowSecs)} from now), ${rerun}`,
      );
    case 'guest_limit_day':
      return new TradeExit(EXIT.guestLimit, `The site's limit on new guest accounts from all networks was reached; it counts over a rolling ${fmtWindow(caps.dayWindowSecs)}, so rerun later, ${rerun}`);
    case 'relayer_empty':
      return new TradeExit(EXIT.failed, 'The site has paused new guest accounts for a moment (its relayer or parent account is low on NEAR). Try again later.');
    case 'not_found':
    case 'not_configured':
      return new TradeExit(EXIT.failed, 'This site does not offer NEAR guest accounts (is --site the NEAR build?).');
    case 'house_account_clash':
      return new TradeExit(EXIT.failed, "The guest's house account name is already in use on chain with another key. Rerun with --fresh.");
    case 'key_used':
      return new TradeExit(EXIT.failed, 'The site could not make an account for this key earlier and will not try again with it. Rerun with --fresh.');
    case 'bad_public_key':
      return new TradeExit(EXIT.failed, 'The site refused the public key as malformed.');
    case 'in_progress':
      return new TradeExit(EXIT.failed, 'The site was still making the guest account after a minute. Rerun in a moment: it will be the same account.');
    default: {
      const detail = typeof body.detail === 'string' ? `: ${body.detail.slice(0, 200)}` : '';
      return new TradeExit(EXIT.failed, `The site could not make the guest account (HTTP ${status}, ${code}${detail}).`);
    }
  }
}

// How a failed relay is handled:
//   'retry'   nothing was sent (the network was busy, the delegate expired,
//             the lock was held): wait a few seconds and send it again once;
//   'unsure'  it may have gone through: look before sending it again;
//   'refused' the relay or the contract said no: report it.
export type RelayErrorKind = 'retry' | 'unsure' | 'refused';

const RETRY_CODES = new Set(['rpc_busy', 'busy', 'stale_nonce', 'expired', 'server_error']);
const UNSURE_CODES = new Set(['rpc_unsure', 'relay_error']);

export function relayErrorKind(err: unknown): RelayErrorKind {
  if (err instanceof NearActError) {
    if (RETRY_CODES.has(err.code)) return 'retry';
    if (UNSURE_CODES.has(err.code)) return 'unsure';
    // A gateway's answer with no body of the route's own: the function
    // may have sent it before the gateway gave up.
    if (/^http_5\d\d$/.test(err.code)) return 'unsure';
    return 'refused';
  }
  // No answer at all (a timeout, a reset connection): it may have gone out.
  return 'unsure';
}

// One line for a relay error: the route's code and the contract's words.
export function relayErrorLine(err: unknown): string {
  if (err instanceof NearActError) {
    const msg = err.contractMessage ? `: ${err.contractMessage}` : err.message && err.message !== err.code ? `: ${err.message}` : '';
    return `${err.code} (HTTP ${err.status})${msg}`;
  }
  return String((err as Error)?.message ?? err).split('\n')[0].slice(0, 200);
}

// The contract's messages that refuse an order because of the market (so
// another market may take it); every other refusal is about the account or
// the order and would refuse it anywhere.
const MARKET_MESSAGES = new Set<string>([
  CONTRACT_MESSAGE.not_listed,
  CONTRACT_MESSAGE.settled,
  CONTRACT_MESSAGE.cooloff,
  CONTRACT_MESSAGE.no_quote,
  CONTRACT_MESSAGE.stale,
  CONTRACT_MESSAGE.low_score,
  CONTRACT_MESSAGE.spread,
  CONTRACT_MESSAGE.zero_price,
]);

export function isMarketRefusal(contractMessage: string | null | undefined): boolean {
  return !!contractMessage && MARKET_MESSAGES.has(contractMessage);
}

// An order refused before it was placed (the relay's check or the
// contract's open): 'market' to try the next market, 'stop' otherwise.
export function openRefusal(err: unknown): { kind: 'market' | 'stop'; reason: string } {
  if (err instanceof NearActError && (err.code === 'would_fail' || err.code === 'failed_on_chain')) {
    const reason = err.contractMessage ?? err.code;
    return { kind: isMarketRefusal(err.contractMessage) ? 'market' : 'stop', reason };
  }
  return { kind: 'stop', reason: relayErrorLine(err) };
}

// The contract's order_refunded reason for each reason the ticket infers.
const REFUND_EVENT: Record<RefundReason, string> = {
  limit: 'limit',
  spread: 'spread',
  full: 'market_full',
  score: 'score',
  zero_price: 'zero_price',
  market_closed: 'market_closed',
  expired: 'expired',
  cancelled: 'cancelled',
};

// A refunded order in one line: the contract's reason name and the
// ticket's sentence. The refund event lands in the keeper's transaction,
// so the reason is worked out from the market's quotes the way the
// browser does (inferRefundReason).
export function refundMessage(reason: RefundReason | null): string {
  return reason ? `${REFUND_EVENT[reason]}: ${refundLine(reason)}` : refundLine(null);
}

// ------------------------------------------------------------ the proof

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});

export interface TxProof {
  hash: string;
  signer: string | null;
  // The delegate inside it: who signed it, the contract, the method.
  sender: string | null;
  receiver: string | null;
  method: string | null;
  succeeded: boolean;
  problems: string[];
}

// One relayed call as the RPC's `tx` shows it: a transaction that the
// relayer signed, holding one Delegate action from the guest's account to
// the contract.
export function txProof(hash: string, result: unknown, expected: { relayer: string; sender: string; contract: string; method: string }): TxProof {
  const r = obj(result);
  const t = obj(r.transaction);
  const signer = typeof t.signer_id === 'string' ? t.signer_id : null;
  const actions = Array.isArray(t.actions) ? t.actions : [];
  const del = obj(obj(actions.map(obj).find((a) => 'Delegate' in a)?.Delegate).delegate_action);
  const sender = typeof del.sender_id === 'string' ? del.sender_id : null;
  const receiver = typeof del.receiver_id === 'string' ? del.receiver_id : null;
  const inner = Array.isArray(del.actions) ? obj(obj(del.actions[0]).FunctionCall) : {};
  const method = typeof inner.method_name === 'string' ? inner.method_name : null;
  const status = obj(r.status);
  const succeeded = 'SuccessValue' in status || 'SuccessReceiptId' in status;
  const problems: string[] = [];
  if (signer !== expected.relayer) problems.push(`signed by ${signer ?? 'nobody readable'}, not ${expected.relayer}`);
  if (actions.length !== 1 || sender === null) problems.push('not one Delegate action');
  else {
    if (sender !== expected.sender) problems.push(`the delegate is from ${sender}, not ${expected.sender}`);
    if (receiver !== expected.contract) problems.push(`the delegate calls ${receiver}, not ${expected.contract}`);
    if (method !== expected.method) problems.push(`the delegate calls ${method}, not ${expected.method}`);
  }
  if (!succeeded) problems.push('the transaction did not succeed');
  return { hash, signer, sender, receiver, method, succeeded, problems };
}

export interface AccountProof {
  amount: bigint | null;
  keys: string[];
  problems: string[];
}

const yoctoNear = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);

// "0.25 NEAR".
export function fmtNear(yocto: bigint): string {
  const s = (Number(yocto) / 1e24).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `${s} NEAR`;
}

// The account as view_account and view_access_key_list show it: 0 NEAR,
// and one key, this one, a function-call key for the contract.
export function accountProof(account: unknown, keyList: unknown, expected: { publicKey: string; contract: string }): AccountProof {
  const amount = yoctoNear(obj(account).amount);
  const raw = Array.isArray(obj(keyList).keys) ? (obj(keyList).keys as unknown[]) : [];
  const problems: string[] = [];
  if (amount === null) problems.push('its balance could not be read');
  else if (amount !== 0n) problems.push(`it holds ${fmtNear(amount)}, not 0`);
  const keys = raw.map((k) => {
    const key = obj(k);
    const pk = typeof key.public_key === 'string' ? key.public_key : '?';
    const perm = obj(key.access_key).permission;
    if (perm === 'FullAccess') return `${pk} full access`;
    const fc = obj(obj(perm).FunctionCall);
    const methods = Array.isArray(fc.method_names) ? (fc.method_names as unknown[]).map(String) : [];
    const allowance = yoctoNear(fc.allowance);
    return `${pk} function call on ${String(fc.receiver_id)}, ${methods.length ? `methods ${methods.join(', ')}` : 'no method list'}${allowance !== null ? `, allowance ${fmtNear(allowance)}` : ''}`;
  });
  if (raw.length !== 1) problems.push(`it has ${raw.length} access keys, not 1`);
  else {
    const key = obj(raw[0]);
    const perm = obj(key.access_key).permission;
    const fc = obj(obj(perm).FunctionCall);
    if (key.public_key !== expected.publicKey) problems.push("its key is not this run's key");
    if (perm === 'FullAccess' || !('FunctionCall' in obj(perm))) problems.push('its key is not a function-call key');
    else if (fc.receiver_id !== expected.contract) problems.push(`its key is for ${String(fc.receiver_id)}, not ${expected.contract}`);
  }
  return { amount, keys, problems };
}
