import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listHouseMarkets, quoteOnDemand, tickHouse, tickHouseFast, minuteOfTick, type HouseChain, type HouseDb, type HouseDeps, type HouseLogEntry } from './house-keeper';
import type { HousePushed } from './house-near';
import type { AtnxMarketRow } from './house-rules';
import { applyQuotes } from './house-rules';
import { CRANK_MAX_IDS, type HouseConfig, type HouseMarket, type HousePosition, type HouseQuote, type HouseVault, type QuoteIn } from './house-types';
import { NearCallError } from './near';
import { buildQuoteBatch, quoteCommitment, type PrintRow } from './quote-commitment';

// The house keeper's runs against an in-memory contract (push_quotes'
// rules: a new print needs a later print time and its score is clipped by
// the time between prints, the same print again needs the numbers as
// pushed, read_at never goes back and is never past the chain's clock; a
// quote that breaks one is skipped and counted), an in-memory database and
// a clock that only moves when the keeper sleeps. The chain's clock runs
// two seconds behind the wall clock, so every read_at shows which clock it
// came from.

const T = 1_794_265_500; // 2026-11-09 23:05:00 UTC, a five-minute boundary
const LAG = 2; // the chain's clock behind the wall's, seconds
const U = 1_000_000n;
const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ref = (c: string) => uuid(c).replace(/-/g, '');
const iso = (secs: number) => new Date(secs * 1000).toISOString();

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
  minStake: 10n * U,
  maxStake: 250n * U,
  maxPositionsPerAccount: 10,
  minFillDelaySecs: 3,
  orderTtlSecs: 900,
  maxQuoteAgeSecs: 900,
  emergencySecs: 86400,
  maxPositionSecs: 14 * 86400,
  lpExitDelaySecs: 86400,
  lpExitWindowSecs: 3600,
  maxStepBps: 1500,
  liqRewardBps: 100,
  faucetPerAccount: 10_000n * U,
  storageFloor: 0n,
  opensPaused: false,
  lpOpen: false,
};

function q(score: number, reading: number, printId: number, printAt: number, readAt: number): HouseQuote {
  const scoreE2 = BigInt(Math.round(score * 100));
  return { scoreE2, pushedScoreE2: scoreE2, readingE2: BigInt(Math.round(reading * 100)), printId: BigInt(printId), printAt, firstReadAt: readAt, lastReadAt: readAt };
}

function mkt(id: number, c: string, quotes: HouseQuote[], status: HouseMarket['status'] = 'Open'): HouseMarket {
  return { id, reference: ref(c), finder: null, liveSince: T - 5 * 86400, status, quotes, finalE2: null, long: null, short: null };
}

function pos(id: number, over: Partial<HousePosition>): HousePosition {
  return {
    id: BigInt(id),
    account: 'alice-h.atnx.testnet',
    market: 0,
    side: 'Long',
    leverage: 3,
    stake: 100n * U,
    fee: 1n * U,
    reserved: 0n,
    state: 'Open',
    placedAt: T - 3600,
    limitE2: 50000n,
    entryE2: 41000n,
    openedAt: T - 3600,
    closeRequestedAt: null,
    closeLimitE2: null,
    ...over,
  };
}

const row = (id: number, c: string, vi: number, raw: number | null, at: number): PrintRow => ({ id, market_id: uuid(c), vi, raw_vi: raw, recorded_at: iso(at) });

// ------------------------------------------------------------ the fakes

class Clock {
  constructor(public ms: number) {}
  now = () => this.ms;
  sleeps: number[] = [];
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.ms += ms;
  };
}

type Call = { method: string; args: Record<string, unknown> };

class FakeChain implements HouseChain {
  calls: Call[] = [];
  views = 0;
  clockReads: number[] = [];
  // Errors thrown by the next sends, by method, in order.
  failures: Record<string, unknown[]> = {};
  keeper: string | null = 'keeper.atnx.testnet';
  missing = false;
  // Called before each push is applied (to change the chain under the keeper).
  beforePush: (() => void) | null = null;
  // Seconds each send takes, on both clocks.
  sendSecs = 0;
  vaultState: HouseVault = { assets: 10_000_000n * U, reserved: 0n, free: 10_000_000n * U, margin: 0n, shares: 1n, sharePrice: '1000000', faucetPool: 50_000n * U };
  constructor(
    public clock: Clock,
    public markets: HouseMarket[],
    public positions: HousePosition[],
    public cfg: HouseConfig = CFG
  ) {}

  private view<T>(f: () => T): Promise<T> {
    this.views++;
    if (this.missing) return Promise.reject(new NearCallError('get_config', null, null, 'get_config: account house.atnx.testnet does not exist while viewing'));
    return Promise.resolve(structuredClone(f()));
  }
  private fail(method: string) {
    const e = this.failures[method]?.shift();
    if (e) throw e;
  }
  contractId = () => 'house.atnx.testnet';
  keeperId = () => this.keeper;
  chainSecs = () => Math.floor(this.clock.ms / 1000) - LAG;
  nowSecs = async () => {
    const t = this.chainSecs();
    this.clockReads.push(t);
    return t;
  };
  config = () => this.view(() => this.cfg);
  vault = () => this.view(() => this.vaultState);
  listMarkets = (from: number, limit: number) => this.view(() => this.markets.slice(from, from + limit));
  market = (id: number) => this.view(() => this.markets.find((m) => m.id === id) ?? null);
  listActive = (from: number, limit: number) => this.view(() => this.positions.slice(from, from + limit));
  position = (id: bigint) => this.view(() => this.positions.find((p) => p.id === id) ?? null);

  // push_quotes as the contract does it: each quote taken or skipped.
  private applyPush(quotes: QuoteIn[], commitment: string): HousePushed['result'] {
    this.beforePush?.();
    const blockSecs = this.chainSecs();
    const taken: QuoteIn[] = [];
    for (const x of quotes) {
      const m = this.markets.find((mm) => mm.id === x.market);
      const last = m?.quotes[m.quotes.length - 1];
      let ok = !!m && m.status !== 'Settled' && x.readAt <= blockSecs && x.printAt <= blockSecs && (!last || x.readAt >= last.lastReadAt);
      if (ok && last && x.printId === last.printId) ok = x.scoreE2 === (last.pushedScoreE2 ?? last.scoreE2) && x.readingE2 === last.readingE2 && x.printAt === last.printAt;
      else if (ok && last) ok = x.printId > last.printId && x.printAt > last.printAt;
      if (ok) taken.push(x);
    }
    this.markets = applyQuotes(this.markets, taken, this.cfg);
    const ids = quotes.map((x) => x.printId);
    return {
      count: quotes.length,
      accepted: taken.length,
      skipped: quotes.length - taken.length,
      firstPrintId: String(ids.reduce((a, b) => (b < a ? b : a))),
      lastPrintId: String(ids.reduce((a, b) => (b > a ? b : a))),
      commitment,
    };
  }
  private send(method: string, args: Record<string, unknown>) {
    this.calls.push({ method, args: structuredClone(args) });
    this.clock.ms += this.sendSecs * 1000;
    this.fail(method);
    return `tx${this.calls.length}`;
  }

  pushQuotes = async (quotes: QuoteIn[], commitment: string): Promise<HousePushed> => {
    const tx = this.send('push_quotes', { quotes, commitment });
    return { txHash: tx, result: this.applyPush(quotes, commitment) };
  };
  crank = async (ids: bigint[]) => {
    if (ids.length > CRANK_MAX_IDS) throw new Error('more ids than crank takes');
    return this.send('crank', { ids });
  };
  pushAndCrank = async (quotes: QuoteIn[], commitment: string | null, ids: bigint[], key: 'main' | 'fast'): Promise<HousePushed> => {
    if (ids.length > CRANK_MAX_IDS) throw new Error('more ids than crank takes');
    const tx = this.send('push_and_crank', { quotes, commitment, ids, key });
    return { txHash: tx, result: quotes.length ? this.applyPush(quotes, commitment!) : null };
  };
  listMarket = async (a: { reference: string; finder: string | null; liveSince: number }) => {
    const tx = this.send('list_market', a);
    const id = Math.max(-1, ...this.markets.map((m) => m.id)) + 1;
    this.markets.push({ ...mkt(id, '0', []), reference: a.reference, finder: a.finder, liveSince: a.liveSince });
    return { txHash: tx, market: id };
  };
  setMarket = async (a: { market: number; status: 'CloseOnly' }) => {
    const tx = this.send('set_market', a);
    this.markets = this.markets.map((m) => (m.id === a.market ? { ...m, status: a.status } : m));
    return tx;
  };
  settleStale = async (market: number) => {
    const tx = this.send('settle_stale', { market });
    this.markets = this.markets.map((m) => (m.id === market ? { ...m, status: 'Settled' as const } : m));
    return tx;
  };
  sent(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

class FakeDb implements HouseDb {
  reads: string[] = [];
  // Rows per market; `later` rows show up from the n-th read of that market on.
  rows = new Map<string, PrintRow[]>();
  later = new Map<string, { fromRead: number; row: PrintRow }>();
  atnx: AtnxMarketRow[] = [];
  accounts = new Map<string, string>();
  fail: string | null = null;
  async newestPrint(marketUuid: string) {
    this.reads.push(marketUuid);
    if (this.fail) throw new Error(this.fail);
    const n = this.reads.filter((r) => r === marketUuid).length;
    const rows = [...(this.rows.get(marketUuid) ?? [])];
    const l = this.later.get(marketUuid);
    if (l && n >= l.fromRead) rows.push(l.row);
    rows.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
    return rows[0] ?? null;
  }
  async atnxMarkets() {
    return structuredClone(this.atnx);
  }
  async nearAccounts(userIds: string[]) {
    return new Map([...this.accounts].filter(([k]) => userIds.includes(k)));
  }
}

function deps(clock: Clock, chain: FakeChain, db: FakeDb, logs: HouseLogEntry[]): Partial<HouseDeps> {
  return { chain, db, now: clock.now, sleep: clock.sleep, log: async (e) => void logs.push(structuredClone(e)), faucetWarnUnits: 100_000n * U };
}

function atnxRow(c: string, over: Partial<AtnxMarketRow> = {}): AtnxMarketRow {
  return {
    id: uuid(c),
    created_at: iso(T - 10 * 86400),
    created_by: `user-${c}`,
    current_vi: 450,
    vi_state: 'live',
    vi_last_updated: iso(T + 45),
    deleted_at: null,
    ...over,
  };
}

// The five-minute scene, at T + 105 s on the wall (T + 103 on the chain):
//   0 A  open, last print 100 a slot ago; print 101 at T+45 in the database
//   1 B  open, print 201 for this slot lands only after the first read
//   2 C  open, newest print 15 minutes old (left out)
//   3 E  open on chain, deleted on atnx.app (→ CloseOnly)
//   4 F  close-only, no quote read for 25 hours (→ settle_stale)
//   5 G  settled (not quoted)
//   D    live on atnx.app for 10 days, not on chain (→ listed, finder dave-h)
//   H    live but under the minimum score (not listed)
// 25 orders on A placed before the read, one placed after it, an open
// position on B that the new print liquidates.
function scene() {
  const clock = new Clock((T + 105) * 1000);
  const markets = [
    mkt(0, 'a', [q(400, 400, 100, T - 255, T - 195)]),
    mkt(1, 'b', [q(450, 450, 200, T - 255, T - 195)]),
    mkt(2, 'c', [q(300, 300, 300, T - 900, T - 840)]),
    mkt(3, 'e', [q(200, 200, 400, T - 7200, T - 7140)]),
    mkt(4, 'f', [q(200, 200, 500, T - 25 * 3600, T - 25 * 3600 + 60)], 'CloseOnly'),
    mkt(5, '9', [q(200, 200, 600, T - 30 * 86400, T - 30 * 86400)], 'Settled'),
  ];
  const positions: HousePosition[] = [];
  for (let i = 1; i <= 25; i++) positions.push(pos(i, { state: 'Pending', placedAt: T + 30, entryE2: null, openedAt: null, limitE2: 45000n }));
  positions.push(pos(26, { state: 'Pending', placedAt: T + 101, entryE2: null, openedAt: null }));
  positions.push(pos(27, { market: 0, entryE2: 40000n }));
  positions.push(pos(28, { market: 1, entryE2: 60000n }));
  const chain = new FakeChain(clock, markets, positions);
  const db = new FakeDb();
  db.rows.set(uuid('a'), [row(100, 'a', 400, 400, T - 255), row(101, 'a', 410.5, 420, T + 45)]);
  db.rows.set(uuid('b'), [row(200, 'b', 450, 450, T - 255)]);
  db.later.set(uuid('b'), { fromRead: 2, row: row(201, 'b', 395, 395, T + 95) });
  db.rows.set(uuid('c'), [row(300, 'c', 300, 300, T - 900)]);
  db.rows.set(uuid('e'), [row(400, 'e', 200, 200, T - 7200)]);
  db.rows.set(uuid('f'), [row(500, 'f', 200, 200, T - 25 * 3600)]);
  db.atnx = [
    atnxRow('a'),
    atnxRow('b'),
    atnxRow('c'),
    atnxRow('d'),
    atnxRow('e', { deleted_at: iso(T - 7000) }),
    atnxRow('f', { deleted_at: iso(T - 25 * 3600) }),
    atnxRow('9', { deleted_at: iso(T - 30 * 86400) }),
    atnxRow('8', { current_vi: 50 }),
  ];
  db.accounts.set('user-d', 'dave.atnx.testnet');
  const logs: HouseLogEntry[] = [];
  return { clock, chain, db, logs, d: deps(clock, chain, db, logs) };
}

// ------------------------------------------------------------ tickHouse

test('tickHouse: read, gate, push, crank in batches of 20, list, close-only, settle, faucet warning', async () => {
  const { chain, db, logs, clock, d } = scene();
  const rep = await tickHouse({ deps: d });
  assert.equal(rep.stopped, null);
  assert.equal(rep.errors, 0);

  // 1. one query per quoted market (not the settled one), B read twice.
  assert.deepEqual(db.reads.slice(0, 5).sort(), [uuid('a'), uuid('b'), uuid('c'), uuid('e'), uuid('f')].sort());
  assert.deepEqual(db.reads.slice(5), [uuid('b'), uuid('c'), uuid('e'), uuid('f')]);
  assert.deepEqual(clock.sleeps, [5000]);
  assert.equal(rep.reread, 4);
  // The chain's clock before each batch of reads (then for the crank rules
  // and the stale markets).
  assert.deepEqual(chain.clockReads.slice(0, 2), [T + 103, T + 108]);

  // 2.-3. C, E and F are too old; A and B pushed in one call, in the
  // batch's order, with the commitment to their rows.
  const [push] = chain.sent('push_quotes');
  const quotes = push.args.quotes as QuoteIn[];
  assert.deepEqual(
    quotes.map((x) => [x.market, x.printId, x.scoreE2, x.readingE2]),
    [
      [0, 101n, 41050n, 42000n],
      [1, 201n, 39500n, 39500n],
    ]
  );
  // read_at: the chain's clock before each batch (A first read, B re-read).
  assert.deepEqual(
    quotes.map((x) => [x.printAt, x.readAt]),
    [
      [T + 45, T + 103],
      [T + 95, T + 108],
    ]
  );
  const expected = quoteCommitment(buildQuoteBatch([row(101, 'a', 410.5, 420, T + 45), row(201, 'b', 395, 395, T + 95)])).hash;
  assert.equal(push.args.commitment, expected);
  assert.equal(rep.pushed, 2);
  assert.equal(rep.pushSkipped, 0);
  assert.equal(rep.gated, 3);

  // 4. 25 orders filled by the new quote and B's long liquidated: 20 + 6.
  const cranks = chain.sent('crank').map((c) => (c.args.ids as bigint[]).map(Number));
  assert.deepEqual(
    cranks.map((c) => c.length),
    [20, 6]
  );
  assert.deepEqual(cranks.flat().sort((a, b) => a - b), [...Array.from({ length: 25 }, (_, i) => i + 1), 28]);
  assert.equal(rep.due, 26);
  assert.equal(rep.active, 28);

  // 5. D listed with its creator's house account; E closed; F settled.
  assert.deepEqual(
    chain.sent('list_market').map((c) => c.args),
    [{ reference: ref('d'), finder: 'dave-h.atnx.testnet', liveSince: T - 10 * 86400 }]
  );
  assert.deepEqual(
    chain.sent('set_market').map((c) => c.args),
    [{ market: 3, status: 'CloseOnly' }]
  );
  assert.deepEqual(
    chain.sent('settle_stale').map((c) => c.args),
    [{ market: 4 }]
  );
  assert.deepEqual(
    chain.calls.map((c) => c.method),
    ['push_quotes', 'crank', 'crank', 'list_market', 'set_market', 'settle_stale']
  );
  assert.deepEqual([rep.listed, rep.closeOnly, rep.settledStale], [1, 1, 1]);

  // 6. and the log, one row per step, the faucet warning among them.
  const actions = logs.map((l) => l.action);
  assert.deepEqual(actions, ['house-tick', 'house-push', 'house-crank', 'house-crank', 'house-list', 'house-close-only', 'house-settle-stale', 'house-faucet-low', 'house-done']);
  assert.ok(logs.every((l) => l.runId === rep.runId && l.detail?.chain === 'near:testnet' && l.detail?.step === 'house'));
  assert.equal(logs[1].txHash, 'tx1');
  assert.deepEqual([logs[1].detail?.accepted, logs[1].detail?.contractSkipped, logs[1].detail?.readAt], [2, 0, T + 103]);
  assert.match(logs.find((l) => l.action === 'house-faucet-low')!.error!, /faucet pool/);
});

test('tickHouse: dry sends nothing, writes nothing, and reports the same plan', async () => {
  const { chain, logs, d } = scene();
  const rep = await tickHouse({ dry: true, deps: d });
  assert.deepEqual(chain.calls, []);
  assert.deepEqual(logs, []);
  assert.equal(rep.dry, true);
  assert.deepEqual([rep.pushed, rep.cranked, rep.listed, rep.closeOnly, rep.settledStale], [2, 26, 1, 1, 1]);
  assert.ok(rep.notes.some((n) => n.startsWith('house-would-push')));
  assert.ok(rep.notes.some((n) => n.startsWith('house-would-list') && n.includes('dave-h.atnx.testnet')));
});

test('tickHouse: an unchanged print is pushed again with the same numbers and a new read_at', async () => {
  const clock = new Clock((T + 105) * 1000);
  const chain = new FakeChain(clock, [mkt(0, 'a', [q(410.5, 420, 101, T + 45, T + 50)])], []);
  const db = new FakeDb();
  db.rows.set(uuid('a'), [row(101, 'a', 410.5, 420, T + 45)]);
  db.atnx = [atnxRow('a')];
  const logs: HouseLogEntry[] = [];
  await tickHouse({ deps: deps(clock, chain, db, logs) });
  const [push] = chain.sent('push_quotes');
  assert.deepEqual(push.args.quotes, [{ market: 0, scoreE2: 41050n, readingE2: 42000n, printId: 101n, printAt: T + 45, readAt: T + 103 }]);
  assert.equal(chain.markets[0].quotes.length, 1);
  assert.equal(chain.markets[0].quotes[0].lastReadAt, T + 103);
  assert.equal(chain.markets[0].quotes[0].firstReadAt, T + 50);
});

test('tickHouse: the same print, clipped on chain, is pushed again with the score as pushed', async () => {
  const clock = new Clock((T + 105) * 1000);
  // Print 101 moved 410 → 480 in a minute: stored clipped, pushed as 480.
  const clipped = { ...q(480, 480, 101, T + 45, T + 50), scoreE2: 41041n, pushedScoreE2: 48000n };
  const chain = new FakeChain(clock, [mkt(0, 'a', [q(410, 410, 100, T - 15, T - 10), clipped])], []);
  const db = new FakeDb();
  db.rows.set(uuid('a'), [row(101, 'a', 480, 480, T + 45)]);
  db.atnx = [atnxRow('a')];
  const rep = await tickHouse({ deps: deps(clock, chain, db, []) });
  const [push] = chain.sent('push_quotes');
  assert.equal((push.args.quotes as QuoteIn[])[0].scoreE2, 48000n);
  assert.equal(rep.pushSkipped, 0);
  assert.equal(chain.markets[0].quotes[1].lastReadAt, T + 103);
  assert.equal(chain.markets[0].quotes[1].scoreE2, 41041n);
});

test('tickHouse: the hourly pass\'s second print, two minutes after the stored one, is pushed at once', async () => {
  const clock = new Clock((T + 105) * 1000);
  const chain = new FakeChain(clock, [mkt(0, 'a', [q(400, 400, 100, T - 75, T - 60)])], []);
  const db = new FakeDb();
  db.rows.set(uuid('a'), [row(101, 'a', 480, 480, T + 45)]);
  db.atnx = [atnxRow('a')];
  await tickHouse({ deps: deps(clock, chain, db, []) });
  assert.deepEqual(
    (chain.sent('push_quotes')[0].args.quotes as QuoteIn[]).map((x) => x.printId),
    [101n]
  );
  // Clipped by the 120 s between the prints: +6 %.
  assert.equal(chain.markets[0].quotes[1].scoreE2, 42400n);
  assert.equal(chain.markets[0].quotes[1].pushedScoreE2, 48000n);
});

test('tickHouse: a quote the contract skips is logged as a warning, not an error', async () => {
  const { chain, logs, d } = scene();
  // Between the keeper's view and its push, a quote on demand read A later.
  chain.beforePush = () => {
    chain.beforePush = null;
    chain.markets[0] = { ...chain.markets[0], quotes: [...chain.markets[0].quotes, q(410.5, 420, 101, T + 45, T + 106)] };
  };
  const rep = await tickHouse({ deps: d });
  assert.equal(chain.sent('push_quotes').length, 1);
  assert.equal(rep.pushSkipped, 1);
  assert.equal(rep.errors, 0);
  const warn = logs.find((l) => l.action === 'house-push-skipped')!;
  assert.match(warn.error!, /skipped 1 of 2 quotes/);
  assert.deepEqual(warn.detail?.accepted, 1);
  // The orders still fill at A's quote read after them, and the run goes on.
  assert.equal(chain.sent('crank').length, 2);
});

test('tickHouse: no contract on chain stops cleanly at the first view with a clear message', async () => {
  const { chain, d, logs } = scene();
  chain.missing = true;
  const rep = await tickHouse({ deps: d });
  assert.match(rep.stopped!, /the house contract house\.atnx\.testnet is not deployed/);
  assert.deepEqual(chain.calls, []);
  assert.deepEqual(
    logs.map((l) => l.action),
    ['house-tick', 'house-chain', 'house-done']
  );
});

test('tickHouse: without the chain\'s clock nothing is pushed, the rest still runs', async () => {
  const { chain, db, d } = scene();
  chain.nowSecs = async () => {
    throw new Error('RPC down');
  };
  const rep = await tickHouse({ deps: d });
  assert.equal(chain.sent('push_quotes').length, 0);
  assert.deepEqual(db.reads, []);
  assert.equal(chain.sent('list_market').length, 1);
  assert.ok(rep.errors >= 1);
});

test('tickHouse: a live run refuses to send when the contract has another keeper', async () => {
  const { chain, d } = scene();
  chain.keeper = 'someone.testnet';
  const rep = await tickHouse({ deps: d });
  assert.match(rep.stopped!, /keeper is keeper\.atnx\.testnet, this keeper signs as someone\.testnet/);
  assert.deepEqual(chain.calls, []);
});

test('tickHouse: a failed atnx.app read skips listing and close-only, never closes everything', async () => {
  const { chain, db, d } = scene();
  db.atnxMarkets = async () => {
    throw new Error('statement timeout');
  };
  const rep = await tickHouse({ deps: d });
  assert.equal(chain.sent('list_market').length, 0);
  assert.equal(chain.sent('set_market').length, 0);
  // The chain-only steps still run.
  assert.equal(chain.sent('push_quotes').length, 1);
  assert.equal(chain.sent('settle_stale').length, 1);
  assert.equal(rep.errors, 1);
});

test('tickHouse: one failing crank batch does not stop the next', async () => {
  const { chain, d } = scene();
  chain.failures.crank = [new NearCallError('crank', null, null, 'crank: RPC timeout')];
  const rep = await tickHouse({ deps: d });
  assert.equal(chain.sent('crank').length, 2);
  assert.equal(rep.cranked, 6);
  assert.equal(rep.errors, 1);
  assert.equal(chain.sent('list_market').length, 1);
});

// ------------------------------------------------------ listHouseMarkets

function listingScene() {
  const clock = new Clock((T + 105) * 1000);
  const chain = new FakeChain(clock, [], []);
  // Each transaction takes 20 seconds.
  chain.sendSecs = 20;
  const db = new FakeDb();
  db.atnx = ['1', '2', '3', '4', '5'].map((c) => atnxRow(c));
  db.atnx.push(atnxRow('6', { current_vi: 50 }));
  db.accounts.set('user-2', 'bob.atnx.testnet');
  const logs: HouseLogEntry[] = [];
  return { clock, chain, db, logs, d: deps(clock, chain, db, logs) };
}

test('listHouseMarkets: every eligible market in one run, past any tick budget', async () => {
  const { chain, d, logs } = listingScene();
  const rep = await listHouseMarkets({ deps: d });
  assert.equal(rep.run, 'list');
  assert.deepEqual(
    chain.sent('list_market').map((c) => c.args.reference),
    ['1', '2', '3', '4', '5'].map(ref)
  );
  assert.equal(chain.sent('list_market')[1].args.finder, 'bob-h.atnx.testnet');
  assert.equal(rep.listed, 5);
  assert.deepEqual(
    chain.calls.map((c) => c.method),
    Array(5).fill('list_market')
  );
  assert.equal(logs.filter((l) => l.action === 'house-list').length, 5);
  // A five-minute tick lists only what fits in its 45 seconds.
  const t = listingScene();
  const tick = await tickHouse({ deps: t.d });
  assert.equal(tick.listed, 3);
  assert.ok(t.logs.some((l) => l.action === 'house-budget'));
});

test('listHouseMarkets: dry by default from the script; a dry run sends and writes nothing', async () => {
  const { chain, d, logs } = listingScene();
  const rep = await listHouseMarkets({ dry: true, deps: d });
  assert.deepEqual(chain.calls, []);
  assert.deepEqual(logs, []);
  assert.equal(rep.listed, 5);
});

test('listHouseMarkets: a settled reference is listed again, a listed one is left alone', async () => {
  const { chain, d } = listingScene();
  chain.markets = [mkt(0, '1', [], 'Settled'), mkt(1, '2', [])];
  const rep = await listHouseMarkets({ deps: d });
  assert.deepEqual(
    chain.sent('list_market').map((c) => c.args.reference),
    ['1', '3', '4', '5'].map(ref)
  );
  assert.equal(rep.listed, 4);
});

// --------------------------------------------------------- tickHouseFast

const FAST_AT = (T + 180) * 1000; // 23:08, not a five-minute run's minute

test('minuteOfTick: minutes 1, 6, 11, ...', () => {
  assert.equal(minuteOfTick((T + 105) * 1000), true);
  assert.equal(minuteOfTick(FAST_AT), false);
});

test('tickHouseFast: sends nothing when nothing waits', async () => {
  const clock = new Clock(FAST_AT);
  const chain = new FakeChain(clock, [mkt(0, 'a', [q(400, 400, 100, T - 255, T - 195)])], [pos(1, { state: 'Open' })]);
  const db = new FakeDb();
  const logs: HouseLogEntry[] = [];
  const rep = await tickHouseFast({ deps: deps(clock, chain, db, logs) });
  assert.deepEqual(chain.calls, []);
  assert.deepEqual(db.reads, []);
  assert.deepEqual(logs, []);
  assert.deepEqual(chain.clockReads, []);
  assert.equal(rep.active, 1);
});

test('tickHouseFast: an order inside its fill delay on the chain\'s clock is left to the quote on demand', async () => {
  const clock = new Clock(FAST_AT);
  // Placed at T+176 on the chain; the chain reads T+178, the delay ends at T+179.
  const chain = new FakeChain(clock, [mkt(0, 'a', [q(400, 400, 100, T - 255, T - 195)])], [pos(1, { state: 'Pending', placedAt: T + 176, entryE2: null, openedAt: null })]);
  const db = new FakeDb();
  await tickHouseFast({ deps: deps(clock, chain, db, []) });
  assert.deepEqual(chain.calls, []);
  assert.deepEqual(db.reads, []);
});

test('tickHouseFast: waiting orders get their markets\' quotes and the crank in one transaction', async () => {
  const clock = new Clock(FAST_AT);
  const markets = [mkt(0, 'a', [q(400, 400, 100, T - 255, T - 195)]), mkt(1, 'b', [q(600, 600, 200, T - 255, T - 195)])];
  const positions = [
    pos(1, { state: 'Pending', placedAt: T + 150, entryE2: null, openedAt: null }),
    pos(2, { market: 0, state: 'Closing', closeRequestedAt: T + 160 }),
    pos(3, { market: 1, state: 'Open', entryE2: 60000n }),
  ];
  const chain = new FakeChain(clock, markets, positions);
  const db = new FakeDb();
  db.rows.set(uuid('a'), [row(101, 'a', 410.5, 420, T + 45)]);
  db.rows.set(uuid('b'), [row(201, 'b', 300, 300, T + 45)]);
  const logs: HouseLogEntry[] = [];
  const rep = await tickHouseFast({ deps: deps(clock, chain, db, logs) });
  // Only A is read: nothing waits on B.
  assert.deepEqual(db.reads, [uuid('a')]);
  assert.equal(chain.calls.length, 1);
  const [call] = chain.calls;
  assert.equal(call.method, 'push_and_crank');
  assert.equal(call.args.key, 'main');
  // read_at is the chain's clock fetched before the read.
  assert.deepEqual(
    (call.args.quotes as QuoteIn[]).map((x) => [x.market, x.printId, x.readAt]),
    [[0, 101n, T + 178]]
  );
  assert.equal(call.args.commitment, quoteCommitment(buildQuoteBatch([row(101, 'a', 410.5, 420, T + 45)])).hash);
  assert.deepEqual(call.args.ids, [1n, 2n]);
  assert.deepEqual(
    logs.map((l) => l.action),
    ['house-fast']
  );
  assert.equal(rep.pushed, 1);
  assert.equal(rep.cranked, 2);
});

test('tickHouseFast: the five-minute run\'s minute is left to it', async () => {
  const clock = new Clock((T + 105) * 1000);
  const chain = new FakeChain(clock, [], [pos(1, { state: 'Pending', placedAt: T, entryE2: null, openedAt: null })]);
  const rep = await tickHouseFast({ deps: deps(clock, chain, new FakeDb(), []) });
  assert.equal(chain.views, 0);
  assert.match(rep.notes.join(), /five-minute run covers this minute/);
});

// --------------------------------------------------------- quoteOnDemand

function onDemandScene(over: { quotes?: HouseQuote[]; placedAt?: number; state?: HousePosition['state'] } = {}) {
  // Placed at T+200 on the chain's clock; the relay calls at T+200.4 on the
  // wall, when the chain reads T+198.
  const placedAt = over.placedAt ?? T + 200;
  const clock = new Clock(placedAt * 1000 + 400);
  const p = pos(7, { state: over.state ?? 'Pending', placedAt, entryE2: null, openedAt: null });
  if (over.state === 'Closing') Object.assign(p, { closeRequestedAt: placedAt, placedAt: T - 3600, entryE2: 40000n, openedAt: T - 3600 });
  const chain = new FakeChain(clock, [mkt(0, 'a', over.quotes ?? [q(400, 400, 100, T - 255, T - 195)])], [p]);
  const db = new FakeDb();
  db.rows.set(uuid('a'), [row(101, 'a', 410.5, 420, T + 45)]);
  const logs: HouseLogEntry[] = [];
  return { clock, chain, db, logs, d: deps(clock, chain, db, logs) };
}

test('quoteOnDemand: waits on the chain\'s clock past the fill delay, then one push and crank with the fast key', async () => {
  const { clock, chain, db, logs, d } = onDemandScene();
  const res = await quoteOnDemand('7', { deps: d });
  assert.equal(res.ok, true);
  assert.equal(res.sent, true);
  assert.equal(res.pushed, true);
  assert.equal(res.attempts, 1);
  // The delay ends at T+203 on the chain, T+205 on the wall: five polls.
  assert.deepEqual(clock.sleeps, [1000, 1000, 1000, 1000, 1000]);
  assert.equal(res.waitedMs, 5000);
  assert.deepEqual(chain.clockReads, [T + 198, T + 199, T + 200, T + 201, T + 202, T + 203]);
  assert.equal(res.readAt, T + 203);
  assert.deepEqual(db.reads, [uuid('a')]);
  const [call] = chain.calls;
  assert.equal(call.method, 'push_and_crank');
  assert.equal(call.args.key, 'fast');
  assert.deepEqual(call.args.ids, [7n]);
  assert.deepEqual(call.args.quotes, [{ market: 0, scoreE2: 41050n, readingE2: 42000n, printId: 101n, printAt: T + 45, readAt: T + 203 }]);
  assert.equal(res.txHash, 'tx1');
  assert.equal(res.pushSkipped, false);
  assert.deepEqual(
    logs.map((l) => l.action),
    ['house-on-demand']
  );
});

test('quoteOnDemand: a close waits from its request', async () => {
  const { clock, chain, d } = onDemandScene({ state: 'Closing' });
  const res = await quoteOnDemand(7n, { deps: d });
  assert.equal(res.ok, true);
  assert.equal(clock.sleeps.length, 5);
  assert.equal(chain.calls.length, 1);
});

test('quoteOnDemand: a stalled chain clock is waited for 30 seconds at most', async () => {
  const { clock, chain, d } = onDemandScene();
  chain.nowSecs = async () => T + 198;
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.sent, res.reason], [false, false, 'wait_timeout']);
  assert.equal(res.waitedMs, 30_000);
  assert.equal(clock.sleeps.length, 30);
  assert.deepEqual(chain.calls, []);
});

test('quoteOnDemand: one retry on a nonce clash', async () => {
  const { chain, d } = onDemandScene();
  chain.failures.push_and_crank = [Object.assign(new Error('Transaction nonce 12 must be larger than nonce of the used access key 12'), { name: 'InvalidNonceError' })];
  const res = await quoteOnDemand(7, { deps: d });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(chain.sent('push_and_crank').length, 2);
});

test('quoteOnDemand: a second nonce clash gives up without throwing', async () => {
  const { chain, d } = onDemandScene();
  const clash = () => new NearCallError('push_quotes+crank', null, null, 'push_quotes+crank: InvalidNonce', { cause: new Error('InvalidNonce') });
  chain.failures.push_and_crank = [clash(), clash()];
  const res = await quoteOnDemand('7', { deps: d });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'nonce');
  assert.equal(res.attempts, 2);
  assert.match(res.error!, /InvalidNonce/);
});

test('quoteOnDemand: never throws, whatever fails', async () => {
  const a = onDemandScene();
  a.chain.config = async () => {
    throw new Error('RPC down');
  };
  const r1 = await quoteOnDemand('7', { deps: a.d });
  assert.deepEqual([r1.ok, r1.reason, r1.error], [false, 'error', 'RPC down']);

  const b = onDemandScene();
  b.db.fail = 'statement timeout';
  const r2 = await quoteOnDemand('7', { deps: b.d });
  assert.deepEqual([r2.ok, r2.reason, r2.error], [false, 'error', 'statement timeout']);
  assert.deepEqual(b.chain.calls, []);

  const c = onDemandScene();
  c.chain.failures.push_and_crank = [new NearCallError('push_quotes+crank', 'opens are paused', 'tx9', 'push_quotes+crank: opens are paused')];
  const r3 = await quoteOnDemand('7', { deps: c.d });
  assert.deepEqual([r3.ok, r3.reason, r3.attempts], [false, 'send_failed', 1]);

  const e = onDemandScene();
  e.d.log = async () => {
    throw new Error('log down');
  };
  const r4 = await quoteOnDemand('7', { deps: e.d });
  assert.equal(r4.ok, true);

  const f = onDemandScene();
  f.chain.nowSecs = async () => {
    throw new Error('no block');
  };
  const r5 = await quoteOnDemand('7', { deps: f.d });
  assert.deepEqual([r5.ok, r5.reason, r5.error], [false, 'error', 'no block']);

  const r6 = await quoteOnDemand('not a number', { deps: onDemandScene().d });
  assert.deepEqual([r6.ok, r6.reason], [false, 'bad_id']);
});

// An error as near-api-js throws it when the RPC rate-limits (HTTP 429).
const rateLimited = () => Object.assign(new Error('{"jsonrpc":"2.0","error":{"code":-429,"message":"Rate limits exceeded"}}'), { cause: 429 });

test('quoteOnDemand: a rate-limited read is tried again after a short pause', async () => {
  const { clock, chain, d } = onDemandScene();
  const position = chain.position;
  let fails = 1;
  chain.position = async (id) => {
    if (fails-- > 0) throw rateLimited();
    return position(id);
  };
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.sent, res.retries, res.error], [true, true, 1, null]);
  assert.equal(clock.sleeps[0], 500);
  assert.equal(chain.sent('push_and_crank').length, 1);
});

test('quoteOnDemand: a failed read of the print is tried again', async () => {
  const { db, chain, d } = onDemandScene();
  const read = db.newestPrint.bind(db);
  let fails = 2;
  db.newestPrint = async (uuid: string) => {
    if (fails-- > 0) throw new Error('canceling statement due to statement timeout');
    return read(uuid);
  };
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.sent, res.retries], [true, true, 2]);
  assert.equal(chain.sent('push_and_crank').length, 1);
});

test('quoteOnDemand: after a rate-limited send the position is read again, and one that filled is left alone', async () => {
  const { chain, d } = onDemandScene();
  chain.failures.push_and_crank = [rateLimited()];
  // The send went through after all: the position is open on the next read.
  const send = chain.pushAndCrank;
  chain.pushAndCrank = async (...a) => {
    try {
      return await send(...a);
    } catch (err) {
      chain.positions = chain.positions.map((p) => ({ ...p, state: 'Open' as const }));
      throw err;
    }
  };
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.sent, res.reason, res.retries], [true, false, 'not_waiting', 1]);
  assert.equal(chain.sent('push_and_crank').length, 1);
});

test('quoteOnDemand: a rate-limited send of an order still waiting is sent again', async () => {
  const { chain, d } = onDemandScene();
  chain.failures.push_and_crank = [rateLimited()];
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.sent, res.retries], [true, true, 1]);
  assert.equal(chain.sent('push_and_crank').length, 2);
});

test('quoteOnDemand: tries stop inside the 30-second budget', async () => {
  const { clock, chain, d } = onDemandScene();
  chain.config = async () => {
    throw rateLimited();
  };
  const t0 = clock.ms;
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.reason], [false, 'error']);
  assert.match(res.error!, /Rate limits exceeded/);
  assert.ok(clock.ms - t0 <= 30_000, `took ${clock.ms - t0} ms`);
  assert.ok(res.retries >= 4);
  assert.deepEqual(chain.calls, []);
});

test('quoteOnDemand: nothing to do for a position that is not waiting, or one that is gone', async () => {
  const a = onDemandScene({ state: 'Open' });
  const r1 = await quoteOnDemand('7', { deps: a.d });
  assert.deepEqual([r1.ok, r1.sent, r1.reason], [true, false, 'not_waiting']);
  assert.deepEqual(a.chain.calls, []);
  const r2 = await quoteOnDemand('8', { deps: onDemandScene().d });
  assert.deepEqual([r2.ok, r2.reason, r2.retries], [false, 'not_found', 3]);
});

test('quoteOnDemand: an order the RPC does not show yet is asked for again', async () => {
  const { chain, d } = onDemandScene();
  const position = chain.position;
  let unseen = 1;
  chain.position = async (id) => (unseen-- > 0 ? null : position(id));
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.sent, res.retries], [true, true, 1]);
});

test('quoteOnDemand: a quote already read after the order needs only the crank', async () => {
  // The every-minute run got there first: print 101 read at T+204.
  const { chain, d } = onDemandScene({ quotes: [q(400, 400, 100, T - 255, T - 195), q(410.5, 420, 101, T + 45, T + 204)] });
  const res = await quoteOnDemand('7', { deps: d });
  assert.equal(res.ok, true);
  assert.equal(res.pushed, false);
  assert.deepEqual(chain.calls[0].args, { quotes: [], commitment: null, ids: [7n], key: 'fast' });
});

test('quoteOnDemand: the hourly pass\'s second print, two minutes after the stored one, is pushed at once', async () => {
  // The chain holds print 101 (T+45) read before the order; the database's
  // newest is the hourly pass's 102, two minutes later.
  const { chain, db, d } = onDemandScene({ quotes: [q(410.5, 420, 101, T + 45, T + 100)] });
  db.rows.set(uuid('a'), [row(101, 'a', 410.5, 420, T + 45), row(102, 'a', 411, 421, T + 165)]);
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.sent, res.pushed], [true, true, true]);
  assert.deepEqual(
    (chain.calls[0].args.quotes as QuoteIn[]).map((x) => [x.printId, x.readAt]),
    [[102n, T + 203]]
  );
  assert.equal(chain.markets[0].quotes[1].printId, 102n);
});

test('quoteOnDemand: an order whose delay is far off on the chain\'s clock is not waited for', async () => {
  const { clock, d } = onDemandScene({ placedAt: T + 400 });
  clock.ms = (T + 200) * 1000;
  const res = await quoteOnDemand('7', { deps: d });
  assert.deepEqual([res.ok, res.reason], [false, 'wait_too_long']);
  assert.deepEqual(clock.sleeps, []);
});
