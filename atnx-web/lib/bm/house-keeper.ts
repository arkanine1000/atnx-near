import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  contractMissing,
  hasFastKey,
  houseChainNowSecs,
  houseEnv,
  houseViews,
  isNonceError,
  keeperHouse,
  keeperHouseFast,
  HOUSE_PAGE,
  type HousePushed,
} from './house-near';
import {
  CRANK_BATCH,
  applyQuotes,
  chainByReference,
  chunk,
  closeOnlyPlan,
  dueAction,
  finderFor,
  healthGate,
  listingPlan,
  missingSlot,
  newestQuote,
  planQuote,
  qualifyingQuote,
  stalePlan,
  waitingSince,
  type AtnxMarketRow,
  type DueAction,
  type PrintRead,
} from './house-rules';
import { referenceToUuid, type HouseConfig, type HouseMarket, type HousePosition, type HouseVault, type PushQuotesResult, type QuoteIn } from './house-types';
import { nearKeeperAccountId } from './near';
import { buildQuoteBatch, quoteCommitment, quoteFromRow, sortQuotesLike, type PrintRow } from './quote-commitment';
import * as registry from './registry';

// The house keeper on NEAR testnet: it reads each listed market's newest VI
// print, pushes the prints to the house contract as quotes with a
// commitment to the rows, cranks every position with something due, and
// keeps the contract's market list in step with atnx.app. Four runs:
//
//   tickHouse       every five minutes, a minute after the VI cron's
//                   boundary (/api/bm/house-keeper, 1-59/5 * * * *):
//                     1. read the newest vi_history row of each listed
//                        market, one small query per market, a few at a
//                        time, and read once more any market whose print for
//                        the current slot is not there yet;
//                     2. leave out a market whose newest print is over ten
//                        minutes old or has no reading;
//                     3. commit to the rows and send one push_quotes;
//                     4. page list_active twice, crank what is due in
//                        batches of 20;
//                     5. list atnx.app markets that qualify, move deleted
//                        ones to CloseOnly, settle markets with no quote for
//                        the contract's emergency_secs;
//                     6. warn when the faucet pool runs low.
//   tickHouseFast   every minute (/api/bm/house-keeper/fast): when an order
//                   or a close is waiting for a quote, one transaction with
//                   those markets' quotes and the crank. Nothing when idle.
//   quoteOnDemand   from the relay route, right after a user's open or
//                   close: that market's quote and the crank, in one
//                   transaction signed with the keeper's second key.
//   listHouseMarkets  by hand (npm run house:tick -- --list): step 5's
//                   listing for every eligible market in one run, one after
//                   the other, with no time budget, for the first deploy.
//
// Every time the contract compares is on the chain's clock, so read_at is
// the latest block's timestamp fetched just before each batch of database
// reads, and the decisions about what is due use the chain's clock too.
//
// Each run is off unless BM_NEAR_HOUSE_ENABLED=1 (checked by the routes and
// the script). Dry mode reads everything, sends nothing and writes nothing;
// the report's notes say what would happen. Live entries land in
// bm.keeper_log with chain 'near:testnet' and step 'house'. A failure on one
// market or one batch is logged and the run moves on.

export const READ_CONCURRENCY = 6;
export const REREAD_DELAY_MS = 5_000;
// No new send starts this long after a run began (the route allows 60 s).
export const HOUSE_BUDGET_MS = 45_000;
// quoteOnDemand waits at most this long, on the chain's clock, for the
// fill delay to pass, polling the latest block.
export const ON_DEMAND_MAX_WAIT_MS = 30_000;
const ON_DEMAND_POLL_MS = 500;
const LOG_CHAIN = 'near:testnet';

export function faucetWarnUnits(env: Record<string, string | undefined> = process.env): bigint {
  const raw = Number(env.BM_NEAR_HOUSE_FAUCET_WARN_USDG ?? 100_000);
  const usdg = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 100_000;
  return BigInt(usdg) * 1_000_000n;
}

// ------------------------------------------------------------- the deps

// The contract as the keeper drives it.
export interface HouseChain {
  contractId(): string;
  // The account the keeper signs as, or null when it is not configured
  // (dry runs need none).
  keeperId(): string | null;
  // The chain's clock: the latest block's timestamp, whole unix seconds.
  nowSecs(): Promise<number>;
  config(): Promise<HouseConfig>;
  vault(): Promise<HouseVault>;
  listMarkets(from: number, limit: number): Promise<HouseMarket[]>;
  market(id: number): Promise<HouseMarket | null>;
  listActive(from: number, limit: number): Promise<HousePosition[]>;
  position(id: bigint): Promise<HousePosition | null>;
  pushQuotes(quotes: QuoteIn[], commitment: string): Promise<HousePushed>;
  crank(ids: bigint[]): Promise<string>;
  // One transaction: the push (when there are quotes), then the crank. The
  // fast key is the keeper's second key.
  pushAndCrank(quotes: QuoteIn[], commitment: string | null, ids: bigint[], key: 'main' | 'fast'): Promise<HousePushed>;
  listMarket(a: { reference: string; finder: string | null; liveSince: number }): Promise<{ txHash: string; market: number }>;
  setMarket(a: { market: number; status: 'CloseOnly' }): Promise<string>;
  settleStale(market: number): Promise<string>;
}

// What the keeper reads from Supabase.
export interface HouseDb {
  // The newest vi_history row of one market, by recorded_at.
  newestPrint(marketUuid: string): Promise<PrintRow | null>;
  atnxMarkets(): Promise<AtnxMarketRow[]>;
  // user id → NEAR (rounds) account id, active rows only.
  nearAccounts(userIds: string[]): Promise<Map<string, string>>;
}

export interface HouseLogEntry {
  runId: string;
  action: string;
  detail?: Record<string, unknown> | null;
  error?: string | null;
  txHash?: string | null;
}

export interface HouseDeps {
  chain: HouseChain;
  db: HouseDb;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(entry: HouseLogEntry): Promise<void>;
  faucetWarnUnits: bigint;
}

export function liveHouseChain(): HouseChain {
  const contract = houseEnv().house;
  return {
    contractId: () => contract,
    keeperId: () => {
      try {
        return nearKeeperAccountId();
      } catch {
        return null;
      }
    },
    nowSecs: () => houseChainNowSecs(),
    config: () => houseViews.config(contract),
    vault: () => houseViews.vault(contract),
    listMarkets: (from, limit) => houseViews.listMarkets(from, limit, contract),
    market: (id) => houseViews.market(id, contract),
    listActive: (from, limit) => houseViews.listActive(from, limit, contract),
    position: (id) => houseViews.position(id, contract),
    pushQuotes: (quotes, commitment) => keeperHouse().pushQuotes(quotes, commitment),
    crank: (ids) => keeperHouse().crank(ids),
    pushAndCrank: (quotes, commitment, ids, key) => (key === 'fast' ? keeperHouseFast() : keeperHouse()).pushAndCrank(quotes, commitment, ids),
    listMarket: (a) => keeperHouse().listMarket(a),
    setMarket: (a) => keeperHouse().setMarket(a),
    settleStale: (market) => keeperHouse().settleStale(market),
  };
}

type NearAccountsDb = {
  bm: {
    Tables: {
      near_accounts: {
        Row: { user_id: string; account_id: string; state: string };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export function supabaseHouseDb(): HouseDb {
  return {
    // On the (market_id, recorded_at desc) index: one row, never a scan.
    async newestPrint(marketUuid) {
      const { data, error } = await createAdminClient()
        .from('vi_history')
        .select('id, market_id, vi, raw_vi, recorded_at')
        .eq('market_id', marketUuid)
        .order('recorded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { id: data.id, market_id: data.market_id, vi: data.vi, raw_vi: data.raw_vi, recorded_at: String(data.recorded_at) };
    },
    async atnxMarkets() {
      const { data, error } = await createAdminClient()
        .from('markets')
        .select('id, created_at, created_by, current_vi, vi_state, vi_last_updated, deleted_at')
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as AtnxMarketRow[];
    },
    async nearAccounts(userIds) {
      const out = new Map<string, string>();
      if (userIds.length === 0) return out;
      const { data, error } = await (createAdminClient() as unknown as SupabaseClient<NearAccountsDb>)
        .schema('bm')
        .from('near_accounts')
        .select('user_id, account_id, state')
        .in('user_id', userIds);
      if (error) throw error;
      for (const r of data ?? []) if (r.state === 'active') out.set(r.user_id, r.account_id);
      return out;
    },
  };
}

function liveDeps(): HouseDeps {
  return {
    chain: liveHouseChain(),
    db: supabaseHouseDb(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (e) => registry.logKeeper(e),
    faucetWarnUnits: faucetWarnUnits(),
  };
}

function withDefaults(deps?: Partial<HouseDeps>): HouseDeps {
  if (deps?.chain && deps.db && deps.now && deps.sleep && deps.log && deps.faucetWarnUnits !== undefined) return deps as HouseDeps;
  return { ...liveDeps(), ...(deps ?? {}) };
}

// --------------------------------------------------------------- report

export interface HouseReport {
  runId: string;
  run: 'tick' | 'fast' | 'list';
  dry: boolean;
  contract: string;
  // Markets on chain, prints read, read again for the current slot, left
  // out by the health gate, left out against the chain's own quote, pushed,
  // and of those pushed, skipped by the contract.
  markets: number;
  read: number;
  reread: number;
  gated: number;
  skipped: number;
  pushed: number;
  pushSkipped: number;
  pushTx: string | null;
  // Positions in list_active, due, sent to crank.
  active: number;
  due: number;
  cranked: number;
  crankTxs: string[];
  listed: number;
  closeOnly: number;
  settledStale: number;
  errors: number;
  // Why the run stopped early, if it did.
  stopped: string | null;
  notes: string[];
}

function emptyReport(run: HouseReport['run'], dry: boolean, contract: string): HouseReport {
  return {
    runId: randomUUID(),
    run,
    dry,
    contract,
    markets: 0,
    read: 0,
    reread: 0,
    gated: 0,
    skipped: 0,
    pushed: 0,
    pushSkipped: 0,
    pushTx: null,
    active: 0,
    due: 0,
    cranked: 0,
    crankTxs: [],
    listed: 0,
    closeOnly: 0,
    settledStale: 0,
    errors: 0,
    stopped: null,
    notes: [],
  };
}

type Log = (entry: Omit<HouseLogEntry, 'runId'>) => Promise<void>;

function makeLog(rep: HouseReport, deps: HouseDeps, dry: boolean): Log {
  return async (entry) => {
    const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : '';
    rep.notes.push(`${entry.action}${detail}${entry.error ? `: ${entry.error}` : ''}`);
    if (dry) return;
    try {
      await deps.log({ runId: rep.runId, ...entry, detail: { chain: LOG_CHAIN, step: 'house', contract: rep.contract, ...(entry.detail ?? {}) } });
    } catch (err) {
      console.error('[house keeper] log failed', (err as Error).message);
    }
  };
}

const msg = (err: unknown) => (err as Error)?.message ?? String(err);

// A failed first view, worded for the person reading the log.
export function describeChainFailure(err: unknown, contract: string): string {
  if (contractMissing(err)) return `the house contract ${contract} is not deployed (or lacks its views): ${msg(err)}`;
  return `could not read the house contract ${contract}: ${msg(err)}`;
}

function summary(rep: HouseReport): Record<string, unknown> {
  const { notes: _notes, ...rest } = rep;
  void _notes;
  return rest;
}

// The counts of a push for the log, and a warning when the contract
// skipped some of the quotes (a warning, not an error: the rest landed).
async function logPushResult(log: Log, rep: HouseReport, pushed: HousePushed, sent: number): Promise<void> {
  const r: PushQuotesResult | null = pushed.result;
  if (!r) {
    rep.notes.push('push landed; its counts could not be read');
    return;
  }
  rep.pushSkipped += r.skipped;
  if (r.skipped > 0) {
    await log({
      action: 'house-push-skipped',
      txHash: pushed.txHash,
      error: `the contract skipped ${r.skipped} of ${r.count} quotes`,
      detail: { count: r.count, accepted: r.accepted, skipped: r.skipped, sent },
    });
  }
}

// ---------------------------------------------------------------- reads

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export async function listAllMarkets(chain: HouseChain, page = HOUSE_PAGE): Promise<HouseMarket[]> {
  const out: HouseMarket[] = [];
  for (let from = 0, i = 0; i < 100; i++) {
    const batch = await chain.listMarkets(from, page);
    out.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return out;
}

// Every pending, open or closing position. The set reorders as positions
// close while it is paged, so `passes` full passes are merged by id.
export async function pageActive(chain: HouseChain, passes = 2, page = HOUSE_PAGE): Promise<HousePosition[]> {
  const byId = new Map<string, HousePosition>();
  for (let pass = 0; pass < passes; pass++) {
    for (let from = 0, i = 0; i < 1000; i++) {
      const batch = await chain.listActive(from, page);
      for (const p of batch) byId.set(p.id.toString(), p);
      if (batch.length < page) break;
      from += page;
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

interface MarketRead extends PrintRead {
  market: HouseMarket;
  uuid: string;
  error: string | null;
}

async function readOne(m: HouseMarket, deps: HouseDeps, readAt: number): Promise<MarketRead> {
  let uuid = '';
  try {
    uuid = referenceToUuid(m.reference);
    return { market: m, uuid, row: await deps.db.newestPrint(uuid), readAt, error: null };
  } catch (err) {
    return { market: m, uuid, row: null, readAt, error: msg(err) };
  }
}

// Step 1: the chain's clock, then the newest print of each market; then,
// for any market whose print for the current slot is missing, the clock
// and the print once more. Throws when the chain's clock cannot be read.
async function readPrints(markets: HouseMarket[], deps: HouseDeps, rep: HouseReport, opts: { reread: boolean; deadline: number }): Promise<MarketRead[]> {
  if (markets.length === 0) return [];
  const readAt = await deps.chain.nowSecs();
  const reads = await mapLimit(markets, READ_CONCURRENCY, (m) => readOne(m, deps, readAt));
  rep.read += reads.filter((r) => r.row).length;
  if (!opts.reread) return reads;
  // The VI cron's slots are on the database's clock, close to the wall's.
  const wallSecs = Math.floor(deps.now() / 1000);
  const missing = reads.map((r, i) => ({ r, i })).filter(({ r }) => !r.error && missingSlot(r, wallSecs));
  if (missing.length === 0 || deps.now() + REREAD_DELAY_MS > opts.deadline) return reads;
  await deps.sleep(REREAD_DELAY_MS);
  const againAt = await deps.chain.nowSecs();
  const again = await mapLimit(missing, READ_CONCURRENCY, ({ r }) => readOne(r.market, deps, againAt));
  missing.forEach(({ i }, k) => {
    const fresh = again[k];
    if (!fresh.error && fresh.row) reads[i] = fresh;
  });
  rep.reread += missing.length;
  return reads;
}

interface PushPlan {
  quotes: QuoteIn[];
  rows: PrintRow[];
  gated: Record<string, number>;
  skipped: Record<string, number>;
  failed: number;
}

const emptyPlan = (): PushPlan => ({ quotes: [], rows: [], gated: {}, skipped: {}, failed: 0 });

// Steps 2 and 3a: the health gate (a print's age at its read, on the
// chain's clock), then each fresh quote against the chain's newest quote
// for its market.
function planPush(reads: MarketRead[], marketsById: Map<number, HouseMarket>): PushPlan {
  const plan = emptyPlan();
  const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
  for (const r of reads) {
    if (r.error) {
      plan.failed++;
      continue;
    }
    const gate = healthGate(r, r.readAt);
    if (!gate.ok) {
      bump(plan.gated, gate.reason);
      continue;
    }
    let q: QuoteIn;
    try {
      q = quoteFromRow(r.row!, r.market.id, r.readAt);
    } catch {
      bump(plan.gated, 'bad_row');
      continue;
    }
    const onChain = marketsById.get(r.market.id) ?? r.market;
    const p = planQuote(q, newestQuote(onChain));
    if (p.action === 'skip') {
      bump(plan.skipped, p.reason);
      continue;
    }
    plan.quotes.push(q);
    plan.rows.push(r.row!);
  }
  const uuidOf = new Map(reads.map((r) => [r.market.id, r.uuid]));
  plan.quotes = sortQuotesLike(plan.quotes, (m) => uuidOf.get(m) ?? '');
  return plan;
}

const countOf = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

function dueList(positions: HousePosition[], markets: HouseMarket[], cfg: HouseConfig, nowSecs: number): Array<{ p: HousePosition; action: DueAction }> {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const out: Array<{ p: HousePosition; action: DueAction }> = [];
  for (const p of positions) {
    const action = dueAction(p, byId.get(p.market), cfg, nowSecs);
    if (action) out.push({ p, action });
  }
  return out;
}

function tally(xs: Array<{ action: DueAction }>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x.action] = (o[x.action] ?? 0) + 1;
  return o;
}

// -------------------------------------------------------------- listing

// Step 5's listing: atnx.app markets that qualify and are not on chain,
// each with its creator's house account as the finder. `deadline` null
// lists them all (the --list run); otherwise no listing starts after it.
async function listEligible(args: {
  atnx: AtnxMarketRow[];
  onChain: HouseMarket[];
  cfg: HouseConfig;
  deps: HouseDeps;
  rep: HouseReport;
  log: Log;
  fail: (action: string, err: unknown, detail?: Record<string, unknown>) => Promise<void>;
  dry: boolean;
  deadline: number | null;
}): Promise<void> {
  const { deps, rep, log, fail, dry } = args;
  const listing = listingPlan({ atnx: args.atnx, chainByRef: chainByReference(args.onChain), cfg: args.cfg, nowSecs: Math.floor(deps.now() / 1000) });
  rep.notes.push(`listing: ${listing.list.length} to list, skipped ${JSON.stringify(listing.skipped)}`);
  if (listing.list.length === 0) return;
  let accounts: Map<string, string>;
  const creators = [...new Set(listing.list.map((c) => c.creator).filter((c): c is string => !!c))];
  try {
    accounts = await deps.db.nearAccounts(creators);
  } catch (err) {
    // Without the creators' accounts the finders would be wrong; list on
    // the next run.
    await fail('house-near-accounts', err);
    return;
  }
  let done = 0;
  for (const c of listing.list) {
    const finder = finderFor(c.creator, accounts);
    const detail = { uuid: c.uuid, finder, liveSince: c.liveSince, relist: c.relist };
    if (dry) {
      rep.listed++;
      await log({ action: 'house-would-list', detail });
      continue;
    }
    if (args.deadline !== null && deps.now() > args.deadline) {
      await log({ action: 'house-budget', detail: { step: 'list', left: listing.list.length - done } });
      break;
    }
    done++;
    try {
      const res = await deps.chain.listMarket({ reference: c.reference, finder, liveSince: c.liveSince });
      rep.listed++;
      await log({ action: 'house-list', txHash: res.txHash, detail: { ...detail, market: res.market } });
    } catch (err) {
      await fail('house-list', err, detail);
    }
  }
}

// ------------------------------------------------------------- the tick

// The five-minute run.
export async function tickHouse(opts: { dry?: boolean; deps?: Partial<HouseDeps> } = {}): Promise<HouseReport> {
  const deps = withDefaults(opts.deps);
  const dry = !!opts.dry;
  const { chain, db } = deps;
  const startedMs = deps.now();
  const deadline = startedMs + HOUSE_BUDGET_MS;
  const rep = emptyReport('tick', dry, chain.contractId());
  const log = makeLog(rep, deps, dry);
  const late = () => deps.now() > deadline;
  const fail = async (action: string, err: unknown, detail?: Record<string, unknown>) => {
    rep.errors++;
    await log({ action, error: msg(err), detail: detail ?? null });
  };
  // The chain's clock for the crank rules and stale markets; the wall
  // clock if the block cannot be read (the contract decides either way).
  const chainNow = async () => {
    try {
      return await chain.nowSecs();
    } catch (err) {
      await fail('house-chain-time', err);
      return Math.floor(deps.now() / 1000);
    }
  };
  const finish = async () => {
    await log({ action: 'house-done', detail: summary(rep) });
    return rep;
  };

  await log({ action: 'house-tick', detail: { dry, fastKey: hasFastKey() } });

  // atnx.app's markets, for step 5. A failed read skips step 5 only.
  let atnx: AtnxMarketRow[] | null = null;
  try {
    atnx = await db.atnxMarkets();
    rep.notes.push(`atnx markets read: ${atnx.length}, ${atnx.filter((r) => !r.deleted_at && r.vi_state === 'live').length} live`);
  } catch (err) {
    await fail('house-atnx-markets', err);
  }

  let cfg: HouseConfig;
  let markets: HouseMarket[];
  try {
    cfg = await chain.config();
    markets = await listAllMarkets(chain);
  } catch (err) {
    rep.stopped = describeChainFailure(err, rep.contract);
    await fail('house-chain', rep.stopped);
    return finish();
  }
  rep.markets = markets.length;
  const keeperId = chain.keeperId();
  if (!dry && keeperId !== cfg.keeper) {
    rep.stopped = `the contract's keeper is ${cfg.keeper}, this keeper signs as ${keeperId ?? '(not configured)'}`;
    await fail('house-chain', rep.stopped);
    return finish();
  }

  // 1. read, 2. health gate
  const quoted = markets.filter((m) => m.status !== 'Settled');
  let reads: MarketRead[] = [];
  try {
    reads = await readPrints(quoted, deps, rep, { reread: true, deadline });
  } catch (err) {
    // No chain clock, no read_at: nothing is pushed this run.
    await fail('house-chain-time', err);
  }
  for (const r of reads) if (r.error) await fail('house-read', r.error, { market: r.market.id, uuid: r.uuid });
  const plan = planPush(reads, new Map(markets.map((m) => [m.id, m])));
  rep.gated = countOf(plan.gated);
  rep.skipped = countOf(plan.skipped);

  // 3. commit and push
  let after: HouseMarket[] = markets;
  const printIds = plan.quotes.map((q) => q.printId);
  const pushDetail = (commitment: string | null) => ({
    count: plan.quotes.length,
    commitment,
    firstPrintId: printIds.length ? printIds.reduce((a, b) => (b < a ? b : a)).toString() : null,
    lastPrintId: printIds.length ? printIds.reduce((a, b) => (b > a ? b : a)).toString() : null,
    readAt: reads[0]?.readAt ?? null,
    gated: plan.gated,
    skipped: plan.skipped,
    reread: rep.reread,
  });
  if (plan.quotes.length === 0) {
    await log({ action: 'house-push-none', detail: pushDetail(null) });
  } else {
    const commitment = quoteCommitment(buildQuoteBatch(plan.rows)).hash;
    if (dry) {
      rep.pushed = plan.quotes.length;
      await log({ action: 'house-would-push', detail: pushDetail(commitment) });
      after = applyQuotes(markets, plan.quotes, cfg);
    } else {
      try {
        const pushed = await chain.pushQuotes(plan.quotes, commitment);
        rep.pushTx = pushed.txHash;
        rep.pushed = plan.quotes.length;
        const r = pushed.result;
        await log({
          action: 'house-push',
          txHash: pushed.txHash,
          detail: { ...pushDetail(commitment), accepted: r?.accepted ?? null, contractSkipped: r?.skipped ?? null },
        });
        await logPushResult(log, rep, pushed, plan.quotes.length);
      } catch (err) {
        await fail('house-push', err, pushDetail(commitment));
      }
      if (rep.pushTx) {
        try {
          after = await listAllMarkets(chain);
        } catch (err) {
          await fail('house-chain', err);
          after = applyQuotes(markets, plan.quotes, cfg);
        }
      }
    }
  }

  // 4. crank
  try {
    const positions = await pageActive(chain, 2);
    rep.active = positions.length;
    const due = dueList(positions, after, cfg, await chainNow());
    rep.due = due.length;
    if (due.length > 0) rep.notes.push(`due: ${JSON.stringify(tally(due))}`);
    for (const batch of chunk(due, CRANK_BATCH)) {
      const ids = batch.map((d) => d.p.id);
      const detail = { ids: ids.map(String), actions: tally(batch) };
      if (dry) {
        rep.cranked += ids.length;
        await log({ action: 'house-would-crank', detail });
        continue;
      }
      if (late()) {
        await log({ action: 'house-budget', detail: { left: due.length - rep.cranked, step: 'crank' } });
        break;
      }
      try {
        const tx = await chain.crank(ids);
        rep.crankTxs.push(tx);
        rep.cranked += ids.length;
        await log({ action: 'house-crank', txHash: tx, detail });
      } catch (err) {
        await fail('house-crank', err, detail);
      }
    }
  } catch (err) {
    await fail('house-active', err);
  }

  // 5. markets
  if (!atnx || atnx.length === 0) {
    rep.notes.push('markets step skipped: atnx.app markets were not read');
  } else {
    await listEligible({ atnx, onChain: after, cfg, deps, rep, log, fail, dry, deadline });

    const atnxById = new Map(atnx.map((r) => [r.id.toLowerCase(), r]));
    for (const m of closeOnlyPlan(after, atnxById)) {
      const detail = { market: m.id, uuid: referenceToUuid(m.reference) };
      if (dry) {
        rep.closeOnly++;
        await log({ action: 'house-would-close-only', detail });
        continue;
      }
      if (late()) break;
      try {
        const tx = await chain.setMarket({ market: m.id, status: 'CloseOnly' });
        rep.closeOnly++;
        await log({ action: 'house-close-only', txHash: tx, detail });
      } catch (err) {
        await fail('house-close-only', err, detail);
      }
    }
  }

  for (const m of stalePlan(after, cfg, await chainNow())) {
    const detail = { market: m.id, uuid: referenceToUuid(m.reference), lastReadAt: Math.max(...m.quotes.map((q) => q.lastReadAt)) };
    if (dry) {
      rep.settledStale++;
      await log({ action: 'house-would-settle-stale', detail });
      continue;
    }
    if (late()) break;
    try {
      const tx = await chain.settleStale(m.id);
      rep.settledStale++;
      await log({ action: 'house-settle-stale', txHash: tx, detail });
    } catch (err) {
      await fail('house-settle-stale', err, detail);
    }
  }

  // 6. housekeeping
  try {
    const vault = await chain.vault();
    if (vault.faucetPool < deps.faucetWarnUnits) {
      await log({
        action: 'house-faucet-low',
        error: `the faucet pool holds ${vault.faucetPool} units, under the ${deps.faucetWarnUnits} warning level`,
        detail: { faucetPool: vault.faucetPool.toString(), warnAt: deps.faucetWarnUnits.toString() },
      });
    }
  } catch (err) {
    await fail('house-vault', err);
  }

  return finish();
}

// ------------------------------------------------------ first listing

// Lists every eligible atnx.app market in one run, one transaction after
// the other and with no time budget: for the first deploy, when some fifty
// markets wait and a tick lists only what fits in its budget. Dry by
// default from the script, like the rest.
export async function listHouseMarkets(opts: { dry?: boolean; deps?: Partial<HouseDeps> } = {}): Promise<HouseReport> {
  const deps = withDefaults(opts.deps);
  const dry = !!opts.dry;
  const { chain } = deps;
  const rep = emptyReport('list', dry, chain.contractId());
  const log = makeLog(rep, deps, dry);
  const fail = async (action: string, err: unknown, detail?: Record<string, unknown>) => {
    rep.errors++;
    await log({ action, error: msg(err), detail: detail ?? null });
  };
  const finish = async () => {
    await log({ action: 'house-done', detail: summary(rep) });
    return rep;
  };
  await log({ action: 'house-list-all', detail: { dry } });

  let atnx: AtnxMarketRow[];
  try {
    atnx = await deps.db.atnxMarkets();
  } catch (err) {
    rep.stopped = `could not read atnx.app's markets: ${msg(err)}`;
    await fail('house-atnx-markets', err);
    return finish();
  }
  let cfg: HouseConfig;
  let markets: HouseMarket[];
  try {
    cfg = await chain.config();
    markets = await listAllMarkets(chain);
  } catch (err) {
    rep.stopped = describeChainFailure(err, rep.contract);
    await fail('house-chain', rep.stopped);
    return finish();
  }
  rep.markets = markets.length;
  const keeperId = chain.keeperId();
  if (!dry && keeperId !== cfg.keeper) {
    rep.stopped = `the contract's keeper is ${cfg.keeper}, this keeper signs as ${keeperId ?? '(not configured)'}`;
    await fail('house-chain', rep.stopped);
    return finish();
  }
  await listEligible({ atnx, onChain: markets, cfg, deps, rep, log, fail, dry, deadline: null });
  return finish();
}

// --------------------------------------------------------- every minute

// The five-minute run fires on minutes 1, 6, 11, ... and pushes every
// market; the minute run leaves those minutes to it.
export function minuteOfTick(nowMs: number): boolean {
  return new Date(nowMs).getUTCMinutes() % 5 === 1;
}

// The every-minute run: orders and closes waiting for a quote. Sends
// nothing when nothing waits. `force` runs even on the five-minute run's
// minute (by hand).
export async function tickHouseFast(opts: { dry?: boolean; force?: boolean; deps?: Partial<HouseDeps> } = {}): Promise<HouseReport> {
  const deps = withDefaults(opts.deps);
  const dry = !!opts.dry;
  const { chain } = deps;
  const startedMs = deps.now();
  const deadline = startedMs + HOUSE_BUDGET_MS;
  const rep = emptyReport('fast', dry, chain.contractId());
  const log = makeLog(rep, deps, dry);
  const fail = async (action: string, err: unknown, detail?: Record<string, unknown>) => {
    rep.errors++;
    await log({ action, error: msg(err), detail: detail ?? null });
  };

  if (!opts.force && minuteOfTick(startedMs)) {
    rep.notes.push('the five-minute run covers this minute');
    return rep;
  }

  let cfg: HouseConfig;
  let positions: HousePosition[];
  try {
    cfg = await chain.config();
    positions = await pageActive(chain, 1);
  } catch (err) {
    rep.stopped = describeChainFailure(err, rep.contract);
    await fail('house-fast', rep.stopped);
    return rep;
  }
  rep.active = positions.length;
  const waiting = positions.filter((p) => p.state === 'Pending' || p.state === 'Closing');
  if (waiting.length === 0) return rep;

  let markets: HouseMarket[];
  let now: number;
  try {
    markets = await listAllMarkets(chain);
    // The chain's clock, before the reads: it decides which fill delays
    // have passed and is the read_at of the rows read next.
    now = await chain.nowSecs();
  } catch (err) {
    await fail('house-fast', describeChainFailure(err, rep.contract));
    return rep;
  }
  rep.markets = markets.length;
  const byId = new Map(markets.map((m) => [m.id, m]));

  // Markets with a waiting position whose fill delay has passed and that
  // have no quote read since.
  const need = new Map<number, HouseMarket>();
  for (const p of waiting) {
    const m = byId.get(p.market);
    if (!m || m.status === 'Settled') continue;
    const since = waitingSince(p) + cfg.minFillDelaySecs;
    if (now < since) continue;
    if (!qualifyingQuote(m, since)) need.set(m.id, m);
  }

  let plan = emptyPlan();
  if (need.size > 0) {
    const reads = await mapLimit([...need.values()], READ_CONCURRENCY, (m) => readOne(m, deps, now));
    rep.read += reads.filter((r) => r.row).length;
    for (const r of reads) if (r.error) await fail('house-read', r.error, { market: r.market.id, uuid: r.uuid });
    plan = planPush(reads, byId);
    rep.gated = countOf(plan.gated);
    rep.skipped = countOf(plan.skipped);
  }
  const after = applyQuotes(markets, plan.quotes, cfg);
  const due = dueList(waiting, after, cfg, now);
  rep.due = due.length;
  if (plan.quotes.length === 0 && due.length === 0) {
    rep.notes.push(`${waiting.length} waiting, nothing to send yet`);
    return rep;
  }

  const commitment = plan.quotes.length ? quoteCommitment(buildQuoteBatch(plan.rows)).hash : null;
  const batches = chunk(due, CRANK_BATCH);
  const first = batches.shift() ?? [];
  const detail = { quotes: plan.quotes.length, commitment, readAt: now, ids: first.map((d) => d.p.id.toString()), actions: tally(first), waiting: waiting.length };
  if (dry) {
    rep.pushed = plan.quotes.length;
    rep.cranked = due.length;
    await log({ action: 'house-would-fast', detail });
    for (const b of batches) await log({ action: 'house-would-crank', detail: { ids: b.map((d) => d.p.id.toString()), actions: tally(b) } });
    return rep;
  }
  try {
    const pushed = await chain.pushAndCrank(
      plan.quotes,
      commitment,
      first.map((d) => d.p.id),
      'main'
    );
    if (plan.quotes.length) rep.pushTx = pushed.txHash;
    rep.pushed = plan.quotes.length;
    rep.cranked += first.length;
    if (first.length) rep.crankTxs.push(pushed.txHash);
    const r = pushed.result;
    await log({ action: 'house-fast', txHash: pushed.txHash, detail: { ...detail, accepted: r?.accepted ?? null, contractSkipped: r?.skipped ?? null } });
    if (plan.quotes.length) await logPushResult(log, rep, pushed, plan.quotes.length);
  } catch (err) {
    await fail('house-fast', err, detail);
    return rep;
  }
  for (const b of batches) {
    if (deps.now() > deadline) break;
    const ids = b.map((d) => d.p.id);
    try {
      const tx = await chain.crank(ids);
      rep.crankTxs.push(tx);
      rep.cranked += ids.length;
      await log({ action: 'house-crank', txHash: tx, detail: { ids: ids.map(String), actions: tally(b) } });
    } catch (err) {
      await fail('house-crank', err, { ids: ids.map(String) });
    }
  }
  return rep;
}

// ------------------------------------------------------------ on demand

export interface OnDemandResult {
  // True when the position was handled: the transaction landed, or there
  // was nothing to do.
  ok: boolean;
  positionId: string;
  sent: boolean;
  // The transaction carried a quote (else it was the crank alone).
  pushed: boolean;
  // The contract skipped the quote it carried (the crank still ran).
  pushSkipped: boolean;
  txHash: string | null;
  attempts: number;
  // Time slept waiting for the chain's clock to pass the fill delay.
  waitedMs: number;
  // The chain time used as read_at.
  readAt: number | null;
  // Why nothing was sent, or what stopped it.
  reason: string | null;
  error: string | null;
}

function parseId(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === 'string' && /^\d{1,20}$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

// For the relay route, right after it relayed a user's open or close on
// the house contract: waits until the chain's clock is past the fill delay
// since the order (or the close request), polling the latest block, reads
// that market's newest print, and sends one transaction with the quote and
// a crank for the position, signed with the keeper's second key. One retry
// on a nonce clash. Never throws: a failure comes back in the result, and
// the every-minute run picks the position up.
export async function quoteOnDemand(positionId: string | number | bigint, opts: { deps?: Partial<HouseDeps> } = {}): Promise<OnDemandResult> {
  const res: OnDemandResult = {
    ok: false,
    positionId: String(positionId),
    sent: false,
    pushed: false,
    pushSkipped: false,
    txHash: null,
    attempts: 0,
    waitedMs: 0,
    readAt: null,
    reason: null,
    error: null,
  };
  let deps: HouseDeps;
  try {
    deps = withDefaults(opts.deps);
  } catch (err) {
    res.reason = 'not_configured';
    res.error = msg(err);
    return res;
  }
  const runId = randomUUID();
  const logResult = async () => {
    try {
      await deps.log({
        runId,
        action: 'house-on-demand',
        txHash: res.txHash,
        error: res.error,
        detail: { chain: LOG_CHAIN, step: 'house', contract: deps.chain.contractId(), ...res, error: undefined, txHash: undefined },
      });
    } catch {
      // The log is best effort here; the result is what the caller needs.
    }
  };
  try {
    const id = parseId(positionId);
    if (id === null) {
      res.reason = 'bad_id';
      return res;
    }
    const { chain, db } = deps;
    const cfg = await chain.config();
    for (;;) {
      res.attempts++;
      const p = await chain.position(id);
      if (!p) {
        res.reason = 'not_found';
        return res;
      }
      if (p.state !== 'Pending' && p.state !== 'Closing') {
        res.ok = true;
        res.reason = 'not_waiting';
        return res;
      }
      // Wait until the chain's clock is min_fill_delay_secs past the order,
      // so a quote read now counts for it.
      const since = waitingSince(p) + cfg.minFillDelaySecs;
      let now = await chain.nowSecs();
      if ((since - now) * 1000 > ON_DEMAND_MAX_WAIT_MS) {
        res.reason = 'wait_too_long';
        return res;
      }
      while (now < since) {
        if (res.waitedMs >= ON_DEMAND_MAX_WAIT_MS) {
          res.reason = 'wait_timeout';
          return res;
        }
        const ms = Math.min(ON_DEMAND_POLL_MS * 2, Math.max(ON_DEMAND_POLL_MS / 2, (since - now) * 1000));
        await deps.sleep(ms);
        res.waitedMs += ms;
        now = await chain.nowSecs();
      }
      const m = await chain.market(p.market);
      if (!m) {
        res.reason = 'no_market';
        return res;
      }
      let quotes: QuoteIn[] = [];
      let commitment: string | null = null;
      if (m.status !== 'Settled') {
        // `now` was read from the chain just before this query: the read_at.
        res.readAt = now;
        const row = await db.newestPrint(referenceToUuid(m.reference));
        const read: PrintRead = { row, readAt: now };
        const gate = healthGate(read, now);
        if (gate.ok) {
          const q = quoteFromRow(row!, m.id, now);
          const plan = planQuote(q, newestQuote(m));
          if (plan.action !== 'skip') {
            quotes = [q];
            commitment = quoteCommitment(buildQuoteBatch([row!])).hash;
          } else if (!qualifyingQuote(m, since)) {
            res.reason = plan.reason;
            return res;
          }
        } else if (!qualifyingQuote(m, since)) {
          res.reason = gate.reason;
          return res;
        }
      }
      try {
        const pushed = await chain.pushAndCrank(quotes, commitment, [id], 'fast');
        res.txHash = pushed.txHash;
        res.sent = true;
        res.pushed = quotes.length > 0;
        res.pushSkipped = (pushed.result?.skipped ?? 0) > 0;
        res.ok = true;
        res.reason = null;
        res.error = null;
        return res;
      } catch (err) {
        if (isNonceError(err) && res.attempts < 2) {
          res.error = msg(err);
          continue;
        }
        res.reason = isNonceError(err) ? 'nonce' : 'send_failed';
        res.error = msg(err);
        return res;
      }
    }
  } catch (err) {
    res.ok = false;
    res.reason = res.reason ?? 'error';
    res.error = msg(err);
    return res;
  } finally {
    await logResult();
  }
}
