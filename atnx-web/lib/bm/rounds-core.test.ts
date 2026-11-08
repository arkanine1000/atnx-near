import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { BmRoundRow, BmRoundState, BmSeriesRow } from '@/lib/supabase/database-bm';
import { buildSettleInputs, settleCommitment, verifySettleInputs, ZERO_COMMITMENT, type SettleRow } from './commitment';
import type { NearRound, NearSeries } from './near';
import { emptyCounts, startSeriesOn, tickRoundsOn, type RoundsChain, type RoundsDeps, type RoundsLog, type RoundsRegistry, type ViSnapshot } from './rounds-core';
import { nearChain, type NearChainSeries, type NearRoundsApi } from './rounds-near';
import type { ClaimSeriesInput, RoundWithSeries } from './rounds-registry';

// The rounds orchestration against an in-memory registry (the same
// compare-and-set and uniqueness rules as 002_rounds.sql) and a fake NEAR
// contract (the same state machine and checks as near/rounds), on a mocked
// clock.

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const MARKET = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const OTHER_MARKET = '1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const U = 1_000_000n;
const NEAR = 'near:testnet';

// ------------------------------------------------------- fake registry

class FakeRegistry {
  series = new Map<string, BmSeriesRow>();
  rounds = new Map<string, BmRoundRow>();
  writes = 0;
  private n = 0;
  private id() {
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
  }
  private now() {
    return new Date().toISOString();
  }
  private withSeries(rows: BmRoundRow[]): RoundWithSeries[] {
    return rows.map((r) => ({ ...structuredClone(r), series: structuredClone(this.series.get(r.series_id)!) }));
  }
  private ofChain(chain: string) {
    return [...this.rounds.values()].filter((r) => this.series.get(r.series_id)?.chain === chain);
  }
  snapshot() {
    return JSON.stringify({ s: [...this.series.values()], r: [...this.rounds.values()] });
  }
  roundOf(seriesId: string, idx: number): BmRoundRow | undefined {
    return [...this.rounds.values()].find((r) => r.series_id === seriesId && r.idx === idx);
  }
  addSeries(row: Partial<BmSeriesRow> & { chain: string; reference: string }): BmSeriesRow {
    const s: BmSeriesRow = {
      id: this.id(),
      atnx_market_id: MARKET,
      program_id: 'rounds.atnx.testnet',
      series_pubkey: null,
      finder_wallet: 'alice.testnet',
      finder_user_id: null,
      round_secs: 3600,
      settle_window_secs: 900,
      first_presale_secs: 600,
      fee_bps: 100,
      finder_bps: 2000,
      ante_usdg: 10,
      fast: true,
      state: 'active',
      create_tx: null,
      error: null,
      created_at: this.now(),
      updated_at: this.now(),
      onchain_series_id: null,
      ...row,
    };
    this.series.set(s.id, s);
    return s;
  }

  api(): RoundsRegistry {
    const RUNNING = ['pending', 'active', 'paused'];
    const OPEN: BmRoundState[] = ['presale', 'opening', 'live', 'settling'];
    const IN_FLIGHT: BmRoundState[] = ['opening', 'live', 'settling'];
    const reg: RoundsRegistry = {
      claimSeries: async (input: ClaimSeriesInput) => {
        const clash = [...this.series.values()].some(
          (s) => s.atnx_market_id === input.atnxMarketId && s.chain === input.chain && s.fast === input.fast && RUNNING.includes(s.state)
        );
        if (clash) return null;
        this.writes++;
        return structuredClone(
          this.addSeries({
            atnx_market_id: input.atnxMarketId,
            chain: input.chain,
            program_id: input.programId,
            reference: input.reference,
            finder_wallet: input.finderWallet,
            finder_user_id: input.finderUserId ?? null,
            round_secs: input.roundSecs,
            settle_window_secs: input.settleWindowSecs,
            first_presale_secs: input.firstPresaleSecs,
            ante_usdg: input.anteUsdg,
            fast: input.fast,
            state: 'pending',
          })
        );
      },
      hasRunningSeries: async (marketId, chain, fast) =>
        [...this.series.values()].some((s) => s.atnx_market_id === marketId && s.chain === chain && s.fast === fast && RUNNING.includes(s.state)),
      markSeriesActive: async (id, patch) => reg.updateSeries(id, { ...patch, state: 'active', error: null }),
      markSeriesFailed: async (id, reason) => reg.updateSeries(id, { state: 'failed', error: reason }),
      updateSeries: async (id, patch) => {
        const s = this.series.get(id);
        if (!s) return;
        this.writes++;
        this.series.set(id, { ...s, ...structuredClone(patch), updated_at: this.now() });
      },
      getSeries: async (id) => structuredClone(this.series.get(id) ?? null),
      listPendingSeries: async (chain) => [...this.series.values()].filter((s) => s.state === 'pending' && s.chain === chain).map((s) => structuredClone(s)),
      insertPresale: async (seriesId, idx, opensAt, roundPubkey) => {
        const rows = [...this.rounds.values()].filter((r) => r.series_id === seriesId);
        if (rows.some((r) => r.idx === idx || r.state === 'presale')) return null;
        this.writes++;
        const r: BmRoundRow = {
          id: this.id(),
          series_id: seriesId,
          idx,
          round_pubkey: roundPubkey,
          state: 'presale',
          opens_at: typeof opensAt === 'string' ? opensAt : opensAt.toISOString(),
          opened_at: null,
          close_at: null,
          trade_until: null,
          target_vi: null,
          settle_vi: null,
          settle_prints: null,
          winner: null,
          presale_up_usdg: null,
          presale_down_usdg: null,
          ante_side: null,
          ante_usdg: null,
          open_tx: null,
          settle_tx: null,
          void_tx: null,
          error: null,
          created_at: this.now(),
          updated_at: this.now(),
        };
        this.rounds.set(r.id, r);
        return structuredClone(r);
      },
      transitionRound: async (id, from, to, patch = {}) => {
        const r = this.rounds.get(id);
        const states = Array.isArray(from) ? from : [from];
        if (!r || !states.includes(r.state)) return false;
        const others = [...this.rounds.values()].filter((x) => x.series_id === r.series_id && x.id !== id);
        if (IN_FLIGHT.includes(to) && others.some((x) => IN_FLIGHT.includes(x.state))) throw Object.assign(new Error('bm_rounds_one_live'), { code: '23505' });
        if (to === 'presale' && others.some((x) => x.state === 'presale')) throw Object.assign(new Error('bm_rounds_one_presale'), { code: '23505' });
        this.writes++;
        this.rounds.set(id, { ...r, ...structuredClone(patch), state: to, updated_at: this.now() });
        return true;
      },
      updateRound: async (id, patch) => {
        const r = this.rounds.get(id);
        if (!r) return;
        const { state: _s, ...rest } = patch;
        void _s;
        this.writes++;
        this.rounds.set(id, { ...r, ...structuredClone(rest), updated_at: this.now() });
      },
      getRound: async (seriesId, idx) => structuredClone(this.roundOf(seriesId, idx) ?? null),
      listDueLive: async (chain, at, delaySecs) =>
        this.withSeries(
          this.ofChain(chain).filter((r) => r.state === 'live' && r.close_at && new Date(r.close_at).getTime() <= at.getTime() - delaySecs * 1000)
        ),
      listPresaleReady: async (chain, at) => {
        const ready = this.ofChain(chain).filter(
          (r) => r.state === 'presale' && new Date(r.opens_at).getTime() <= at.getTime() && this.series.get(r.series_id)!.state === 'active'
        );
        const busy = new Set([...this.rounds.values()].filter((r) => IN_FLIGHT.includes(r.state)).map((r) => r.series_id));
        return this.withSeries(ready.filter((r) => !busy.has(r.series_id)));
      },
      listInFlight: async (chain) => this.withSeries(this.ofChain(chain).filter((r) => r.state === 'opening' || r.state === 'settling')),
      listPausedWithPresale: async (chain) =>
        this.withSeries(this.ofChain(chain).filter((r) => r.state === 'presale' && this.series.get(r.series_id)!.state === 'paused')),
      listRoundsToClaim: async (chain, sinceDays = 7) =>
        this.withSeries(
          this.ofChain(chain).filter(
            (r) => (r.state === 'settled' || r.state === 'void') && r.ante_side !== null && new Date(r.updated_at).getTime() >= Date.now() - sinceDays * 86_400_000
          )
        ),
      hasOpenRounds: async (seriesId) => [...this.rounds.values()].some((r) => r.series_id === seriesId && OPEN.includes(r.state)),
    };
    return reg;
  }
}

// ---------------------------------------------------- fake NEAR contract

class Panic extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class FakeNear implements NearRoundsApi {
  series = new Map<number, NearSeries>();
  rounds = new Map<string, NearRound>();
  positions = new Set<string>();
  sends: { method: string; args: Record<string, unknown> }[] = [];
  minimums: bigint[] = [];
  private tx = 0;
  readonly keeper = 'keeper.atnx.testnet';

  private now() {
    return Math.floor(Date.now() / 1000);
  }
  private send(method: string, args: Record<string, unknown>) {
    this.sends.push({ method, args });
    return `tx${++this.tx}-${method}`;
  }
  private s(id: number): NearSeries {
    const s = this.series.get(id);
    if (!s) throw new Panic('no such series');
    return s;
  }
  private r(sid: number, idx: number): NearRound {
    const r = this.rounds.get(`${sid}:${idx}`);
    if (!r) throw new Panic('no such round');
    return r;
  }
  private presale(sid: number, idx: number): NearRound {
    const zero = 0n;
    return {
      seriesId: sid,
      index: idx,
      state: 'presale',
      winner: null,
      presaleUp: zero,
      presaleDown: zero,
      mUp: zero,
      mDown: zero,
      nUp: zero,
      nDown: zero,
      openedAt: 0,
      closeAt: 0,
      tradeUntil: 0,
      targetE2: zero,
      settleE2: zero,
      commitment: ZERO_COMMITMENT,
      paidOut: zero,
    };
  }

  contractId = () => 'rounds.atnx.testnet';
  keeperId = () => this.keeper;
  seriesByReference = async (reference: string) => {
    const s = [...this.series.values()].find((x) => x.reference === reference);
    return s ? structuredClone(s) : null;
  };
  round = async (sid: number, idx: number) => structuredClone(this.rounds.get(`${sid}:${idx}`) ?? null);
  hasPosition = async (sid: number, idx: number, account: string) => this.positions.has(`${sid}:${idx}:${account}`);

  createSeries = async (a: { reference: string; roundSecs: number; settleWindowSecs: number; ante: bigint; finder: string }) => {
    if ([...this.series.values()].some((s) => s.reference === a.reference)) throw new Panic('a series with this reference already exists');
    const id = this.series.size + 1;
    this.series.set(id, {
      id,
      finder: a.finder,
      reference: a.reference,
      roundSecs: a.roundSecs,
      settleWindowSecs: a.settleWindowSecs,
      feeBps: 100,
      finderBps: 2000,
      ante: a.ante,
      paused: false,
      liveRound: 0,
      presaleRound: 1,
      finderFees: 0n,
      platformFees: 0n,
    });
    this.rounds.set(`${id}:1`, this.presale(id, 1));
    return { txHash: this.send('create_series', a), seriesId: id };
  };

  // A commit by anyone (the keeper's ante goes through `commit` below).
  commitAs(account: string, a: { seriesId: number; roundIndex: number; side: 'up' | 'down'; amount: bigint }) {
    const s = this.s(a.seriesId);
    if (s.paused) throw new Panic('series is paused');
    const r = this.r(a.seriesId, a.roundIndex);
    if (r.state !== 'presale' || r.index !== s.presaleRound) throw new Panic("round is not the series' presale round");
    const fee = (a.amount * 100n + 9_999n) / 10_000n;
    if (a.side === 'up') r.presaleUp += a.amount - fee;
    else r.presaleDown += a.amount - fee;
    this.positions.add(`${a.seriesId}:${a.roundIndex}:${account}`);
  }
  commit = async (a: { seriesId: number; roundIndex: number; side: 'up' | 'down'; amount: bigint }) => {
    this.commitAs(this.keeper, a);
    return this.send('commit', a);
  };
  openRound = async (a: { seriesId: number; targetE2: bigint }) => {
    const s = this.s(a.seriesId);
    if (s.paused) throw new Panic('series is paused');
    if (s.liveRound !== 0) throw new Panic('a live round already exists');
    const r = this.r(a.seriesId, s.presaleRound);
    if (r.presaleUp === 0n || r.presaleDown === 0n) throw new Panic('both sides need money before a round can open');
    const now = this.now();
    Object.assign(r, {
      state: 'live',
      mUp: r.presaleUp,
      mDown: r.presaleDown,
      nUp: r.presaleUp + r.presaleDown,
      nDown: r.presaleUp + r.presaleDown,
      targetE2: a.targetE2,
      openedAt: now,
      closeAt: now + s.roundSecs,
      tradeUntil: now + s.roundSecs - s.settleWindowSecs,
    });
    s.liveRound = r.index;
    s.presaleRound = r.index + 1;
    this.rounds.set(`${a.seriesId}:${r.index + 1}`, this.presale(a.seriesId, r.index + 1));
    return this.send('open_round', a);
  };
  settle = async (a: { seriesId: number; settleE2: bigint; commitment: string }) => {
    const s = this.s(a.seriesId);
    const r = this.r(a.seriesId, s.liveRound);
    if (r.state !== 'live') throw new Panic("round is not the series' live round");
    if (this.now() < r.closeAt) throw new Panic('round has not reached its close');
    if (!/^[0-9a-f]{64}$/.test(a.commitment)) throw new Panic('commitment must be 64 lowercase hex characters');
    Object.assign(r, { state: 'settled', winner: a.settleE2 >= r.targetE2 ? 'up' : 'down', settleE2: a.settleE2, commitment: a.commitment });
    s.liveRound = 0;
    return this.send('settle', a);
  };
  voidRound = async (a: { seriesId: number; roundIndex: number }) => {
    const s = this.s(a.seriesId);
    const r = this.r(a.seriesId, a.roundIndex);
    if (r.state === 'live') {
      if (this.now() < r.closeAt) throw new Panic('round has not reached its close');
      s.liveRound = 0;
    } else if (r.state === 'presale') {
      if (!s.paused) throw new Panic('series is not paused');
      s.presaleRound = 0;
    } else throw new Panic('round index or state does not fit this call');
    r.state = 'void';
    return this.send('void_round', a);
  };
  pause = async (seriesId: number) => {
    this.s(seriesId).paused = true;
    return this.send('set_series', { seriesId, paused: true });
  };
  claim = async (a: { seriesId: number; roundIndex: number }) => {
    const r = this.r(a.seriesId, a.roundIndex);
    if (r.state !== 'settled' && r.state !== 'void') throw new Panic('round is not settled');
    const key = `${a.seriesId}:${a.roundIndex}:${this.keeper}`;
    if (!this.positions.delete(key)) throw new Panic('no position in this round');
    return this.send('claim', a);
  };
  ensureKeeperUsdg = async (minimum: bigint) => {
    this.minimums.push(minimum);
  };
  methods() {
    return this.sends.map((s) => s.method);
  }
}

// --------------------------------------------------------------- harness

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const store = new FakeRegistry();
  const reg = store.api();
  const chainApi = new FakeNear();
  const vi = new Map<string, ViSnapshot>();
  const prints = new Map<string, SettleRow[]>();
  const freshVi = (id: string, v: number) => vi.set(id, { vi: v, state: 'live', updatedAt: new Date().toISOString() });
  const deps: RoundsDeps = {
    registry: reg,
    readLiveVi: async (id) => vi.get(id) ?? null,
    settlementRows: async (id, closeAt, windowSecs) => {
      const from = closeAt.getTime() - windowSecs * 1000;
      return (prints.get(id) ?? []).filter((p) => {
        const at = new Date(p.recorded_at).getTime();
        return at >= from && at <= closeAt.getTime();
      });
    },
    marketCreator: async () => null,
  };
  const logs: Parameters<RoundsLog>[0][] = [];
  const log: RoundsLog = async (e) => {
    logs.push(e);
  };
  const tick = async (opts: { dry?: boolean; chain?: RoundsChain<NearChainSeries>; deadline?: number } = {}) => {
    const rep = emptyCounts();
    const from = logs.length;
    await tickRoundsOn(opts.chain ?? nearChain(chainApi), { dry: !!opts.dry, log, rep, deadline: opts.deadline ?? Date.now() + 45_000 }, deps);
    return { rep, logs: logs.slice(from) };
  };
  const at = (ms: number) => t.mock.timers.setTime(ms);
  return { store, reg, chainApi, vi, prints, freshVi, deps, logs, tick, at };
}

async function startNear(h: ReturnType<typeof setup>, market = MARKET) {
  h.freshVi(market, 412.35);
  const res = await startSeriesOn(nearChain(h.chainApi), { atnxMarketId: market, finderWallet: 'alice.testnet', fast: true }, h.deps);
  assert.ok(res.ok && !('dry' in res), JSON.stringify(res));
  return res as { ok: true; series: BmSeriesRow; round: BmRoundRow };
}

const actions = (logs: Parameters<RoundsLog>[0][]) => logs.map((l) => l.action);

// ------------------------------------------------------------------ tests

test('start: a NEAR series is claimed, created on chain and recorded with its id', async (t) => {
  const h = setup(t);
  const { series, round } = await startNear(h);
  assert.equal(series.chain, NEAR);
  assert.equal(series.state, 'active');
  assert.equal(series.program_id, 'rounds.atnx.testnet');
  assert.equal(series.finder_wallet, 'alice.testnet');
  assert.equal(series.onchain_series_id, 1);
  assert.equal(series.series_pubkey, null);
  assert.equal(series.create_tx, 'tx1-create_series');
  assert.match(series.reference, /^[0-9a-f]{64}$/);
  assert.equal(series.reference.slice(0, 32), MARKET.replace(/-/g, ''));
  assert.equal(series.reference.slice(32, 34), '01', 'the fast flag');
  assert.deepEqual([series.round_secs, series.settle_window_secs, series.first_presale_secs, Number(series.ante_usdg)], [3600, 900, 600, 10]);
  assert.equal(round.idx, 1);
  assert.equal(round.state, 'presale');
  assert.equal(round.round_pubkey, null);
  assert.equal(round.opens_at, new Date(T0 + 600_000).toISOString());
  const onChain = h.chainApi.series.get(1)!;
  assert.deepEqual([onChain.reference, onChain.finder, onChain.ante, onChain.roundSecs], [series.reference, 'alice.testnet', 10n * U, 3600]);

  const again = await startSeriesOn(nearChain(h.chainApi), { atnxMarketId: MARKET, finderWallet: 'bob.testnet', fast: true }, h.deps);
  assert.deepEqual(again, { ok: false, error: 'Rounds are already running on this market', code: 'already_active' });
});

test('start: refuses a finder that is not a NEAR account, a stale VI; dry returns the plan', async (t) => {
  const h = setup(t);
  h.freshVi(MARKET, 412.35);
  const near = nearChain(h.chainApi);
  assert.deepEqual(await startSeriesOn(near, { atnxMarketId: MARKET, finderWallet: '5a5yfYQBX3QYqWZ55agFTHQoxg5Lc4TvT8g3roMfqa2S', fast: false }, h.deps), {
    ok: false,
    error: 'bad wallet',
    code: 'chain',
  });
  const dry = await startSeriesOn(near, { atnxMarketId: MARKET, finderWallet: ' alice.testnet ', fast: false, dry: true }, h.deps);
  assert.ok(dry.ok && 'dry' in dry);
  assert.deepEqual({ ...dry.plan, reference: 'x' }, {
    atnxMarketId: MARKET,
    chain: NEAR,
    programId: 'rounds.atnx.testnet',
    reference: 'x',
    finderWallet: 'alice.testnet',
    finderUserId: null,
    fast: false,
    roundSecs: 86400,
    settleWindowSecs: 1800,
    firstPresaleSecs: 3600,
    anteUsdg: 10,
  });
  assert.equal(h.store.writes, 0);
  assert.equal(h.chainApi.sends.length, 0);
  h.vi.set(MARKET, { vi: 412.35, state: 'live', updatedAt: new Date(T0 - 31 * 60_000).toISOString() });
  const stale = await startSeriesOn(near, { atnxMarketId: MARKET, finderWallet: 'alice.testnet', fast: false }, h.deps);
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.code, 'stale_vi');
});

test('tick: ante both empty sides, open at the VI, next presale at the close', async (t) => {
  const h = setup(t);
  const { series } = await startNear(h);
  h.chainApi.sends.length = 0;

  h.at(T0 + 60_000);
  let r = await h.tick();
  assert.equal(h.chainApi.sends.length, 0, 'not yet time');
  assert.deepEqual(r.rep, emptyCounts());

  h.at(T0 + 601_000);
  h.freshVi(MARKET, 412.35);
  r = await h.tick();
  assert.deepEqual(h.chainApi.methods(), ['commit', 'commit', 'open_round']);
  assert.deepEqual(h.chainApi.sends[0].args, { seriesId: 1, roundIndex: 1, side: 'up', amount: 10n * U });
  assert.deepEqual(h.chainApi.sends[1].args, { seriesId: 1, roundIndex: 1, side: 'down', amount: 10n * U });
  assert.deepEqual(h.chainApi.sends[2].args, { seriesId: 1, targetE2: 41235n });
  assert.deepEqual(h.chainApi.minimums, [20n * U]);
  assert.deepEqual(actions(r.logs), ['anted', 'anted', 'opened']);
  assert.deepEqual({ ...r.rep }, { ...emptyCounts(), anted: 1, opened: 1 });

  const r1 = h.store.roundOf(series.id, 1)!;
  const closeAt = new Date(T0 + 601_000 + 3600_000).toISOString();
  assert.equal(r1.state, 'live');
  assert.deepEqual(
    [r1.ante_side, Number(r1.ante_usdg), Number(r1.target_vi), Number(r1.presale_up_usdg), Number(r1.presale_down_usdg), r1.close_at, r1.open_tx, r1.round_pubkey],
    ['both', 20, 412.35, 9.9, 9.9, closeAt, 'tx4-open_round', null]
  );
  const r2 = h.store.roundOf(series.id, 2)!;
  assert.equal(r2.state, 'presale');
  assert.equal(r2.opens_at, closeAt);
});

test('tick: settle on the window average with the oracle commitment, then open the next round and claim the ante', async (t) => {
  const h = setup(t);
  const { series } = await startNear(h);
  h.at(T0 + 601_000);
  h.freshVi(MARKET, 412.35);
  await h.tick();
  const live = h.chainApi.rounds.get('1:1')!;
  const close = live.closeAt;

  const rows: SettleRow[] = [
    { vi: 413.1, recorded_at: new Date((close - 60) * 1000).toISOString().replace('Z', '+00:00') },
    { vi: 411.0, recorded_at: new Date((close - 800) * 1000).toISOString() },
    { vi: 412.0, recorded_at: new Date((close - 400) * 1000).toISOString() },
    { vi: 999, recorded_at: new Date((close - 901) * 1000).toISOString() },
  ];
  h.prints.set(MARKET, rows);

  h.at(close * 1000 + 299_000);
  let r = await h.tick();
  assert.deepEqual(actions(r.logs), [], 'the settle delay has not passed');

  h.at(close * 1000 + 301_000);
  h.freshVi(MARKET, 412.5);
  h.chainApi.sends.length = 0;
  r = await h.tick();
  assert.deepEqual(h.chainApi.methods(), ['settle', 'commit', 'commit', 'open_round', 'claim']);
  assert.deepEqual(actions(r.logs), ['settled', 'anted', 'anted', 'opened', 'claimed-ante']);
  assert.deepEqual({ ...r.rep }, { ...emptyCounts(), settled: 1, anted: 1, opened: 1, claimed: 1 });

  const expected = buildSettleInputs({ marketId: MARKET, reference: series.reference, roundIndex: 1, closeAt: close, windowSecs: 900, rows: rows.slice(0, 3) })!;
  const { hash } = settleCommitment(expected);
  assert.equal(expected.average_e2, 41203);
  assert.deepEqual(h.chainApi.sends[0].args, { seriesId: 1, settleE2: 41203n, commitment: hash });

  const row = h.store.roundOf(series.id, 1)!;
  assert.equal(row.state, 'settled');
  assert.deepEqual(row.settle_inputs, expected);
  assert.equal(row.settle_commitment, hash);
  assert.deepEqual([Number(row.settle_vi), row.settle_prints, row.winner, row.settle_tx], [412.03, 3, 'down', 'tx5-settle']);
  const settled = h.chainApi.rounds.get('1:1')!;
  assert.equal(settled.commitment, hash);
  assert.deepEqual(verifySettleInputs(JSON.parse(JSON.stringify(row.settle_inputs)), settled, { marketId: MARKET, reference: series.reference, roundIndex: 1, windowSecs: 900 }).problems, []);
  assert.equal(r.logs[0].detail?.commitment, hash);

  // The keeper's round-1 position is gone; the next tick does not claim twice.
  assert.equal(await h.chainApi.hasPosition(1, 1, h.chainApi.keeper), false);
  assert.equal(h.store.roundOf(series.id, 2)!.state, 'live');
  assert.equal(h.store.roundOf(series.id, 3)!.state, 'presale');
  h.chainApi.sends.length = 0;
  r = await h.tick();
  assert.deepEqual(h.chainApi.methods(), []);
});

test('tick: no print in the window waits, then voids 30 minutes after the close', async (t) => {
  const h = setup(t);
  const { series } = await startNear(h);
  h.at(T0 + 601_000);
  h.freshVi(MARKET, 412.35);
  await h.tick();
  const close = h.chainApi.rounds.get('1:1')!.closeAt;
  h.vi.delete(MARKET); // nothing opens round 2 meanwhile

  h.at(close * 1000 + 301_000);
  let r = await h.tick();
  assert.deepEqual(actions(r.logs).slice(0, 1), ['settle-waiting']);
  assert.equal(h.store.roundOf(series.id, 1)!.state, 'live');

  h.at(close * 1000 + 30 * 60_000 + 1_000);
  h.chainApi.sends.length = 0;
  r = await h.tick();
  assert.deepEqual(h.chainApi.methods().slice(0, 1), ['void_round']);
  const row = h.store.roundOf(series.id, 1)!;
  assert.deepEqual([row.state, row.void_tx, row.settle_prints, row.settle_inputs ?? null], ['void', 'tx5-void_round', 0, null]);
  assert.equal(h.chainApi.rounds.get('1:1')!.state, 'void');
  assert.equal(r.rep.voided, 1);
  // The void round's ante is claimed back (step 6 of the same tick).
  assert.deepEqual(h.chainApi.methods(), ['void_round', 'claim']);
});

test('tick: reconcile an `opening` row against the chain, both ways', async (t) => {
  const h = setup(t);
  const { series } = await startNear(h);
  const r1 = h.store.roundOf(series.id, 1)!;

  // The open never landed: the chain still shows presale.
  await h.reg.transitionRound(r1.id, 'presale', 'opening', { target_vi: 412.35 });
  h.at(T0 + 3 * 60_000);
  h.vi.delete(MARKET);
  let r = await h.tick();
  assert.deepEqual(actions(r.logs), ['reconcile-retry']);
  assert.equal(h.store.roundOf(series.id, 1)!.state, 'presale');
  assert.equal(r.rep.reconciled, 1);

  // The open landed but the bookkeeping did not: the chain shows live.
  h.chainApi.commitAs('alice.testnet', { seriesId: 1, roundIndex: 1, side: 'up', amount: 50n * U });
  h.chainApi.commitAs('bob.testnet', { seriesId: 1, roundIndex: 1, side: 'down', amount: 25n * U });
  await h.chainApi.openRound({ seriesId: 1, targetE2: 41235n });
  await h.reg.transitionRound(r1.id, 'presale', 'opening', {});
  h.at(T0 + 6 * 60_000);
  r = await h.tick();
  assert.deepEqual(actions(r.logs), ['reconciled']);
  const row = h.store.roundOf(series.id, 1)!;
  assert.deepEqual([row.state, Number(row.presale_up_usdg), Number(row.presale_down_usdg), Number(row.target_vi)], ['live', 49.5, 24.75, 412.35]);
  assert.equal(h.store.roundOf(series.id, 2)!.state, 'presale');
});

test('tick: a `settling` row whose settle landed is finished from the chain, commitment included', async (t) => {
  const h = setup(t);
  const { series } = await startNear(h);
  h.at(T0 + 601_000);
  h.freshVi(MARKET, 412.35);
  await h.tick();
  const close = h.chainApi.rounds.get('1:1')!.closeAt;
  h.at(close * 1000 + 301_000);
  const commitment = 'ab'.repeat(32);
  await h.chainApi.settle({ seriesId: 1, settleE2: 41300n, commitment });
  const row = h.store.roundOf(series.id, 1)!;
  await h.reg.transitionRound(row.id, 'live', 'settling', { settle_vi: 413 });
  h.vi.delete(MARKET);
  h.at(close * 1000 + 600_000);
  const r = await h.tick();
  assert.deepEqual(actions(r.logs).slice(0, 1), ['reconciled']);
  const after = h.store.roundOf(series.id, 1)!;
  assert.deepEqual([after.state, after.winner, Number(after.settle_vi), after.settle_commitment], ['settled', 'up', 413, commitment]);
});

test('tick: a paused series is paused on chain, its presale voided, and it ends', async (t) => {
  const h = setup(t);
  const { series } = await startNear(h);
  await h.reg.updateSeries(series.id, { state: 'paused' });
  h.chainApi.sends.length = 0;
  const r = await h.tick();
  assert.deepEqual(h.chainApi.methods(), ['set_series', 'void_round']);
  assert.deepEqual(actions(r.logs), ['voided']);
  assert.equal(h.store.roundOf(series.id, 1)!.state, 'void');
  assert.equal(h.store.series.get(series.id)!.state, 'ended');
  assert.equal(h.chainApi.series.get(1)!.presaleRound, 0);
});

test('tick: dry mode reads and logs, and neither writes nor sends', async (t) => {
  const h = setup(t);
  await startNear(h);
  h.chainApi.sends.length = 0;
  h.at(T0 + 601_000);
  h.freshVi(MARKET, 412.35);
  const before = h.store.snapshot();
  const writes = h.store.writes;
  const r = await h.tick({ dry: true });
  assert.deepEqual(actions(r.logs), ['would-ante', 'would-open']);
  assert.deepEqual(r.logs[0].detail, { side: 'both', usdg: 10 });
  assert.deepEqual(r.logs[1].detail, { target: 412.35, presaleUp: 0, presaleDown: 0 });
  assert.deepEqual({ ...r.rep }, { ...emptyCounts(), anted: 1, opened: 1 });
  assert.equal(h.store.snapshot(), before);
  assert.equal(h.store.writes, writes);
  assert.deepEqual(h.chainApi.sends, []);
  assert.deepEqual(h.chainApi.minimums, []);
});

test('tick: a stale VI defers the open and antes nothing', async (t) => {
  const h = setup(t);
  await startNear(h);
  h.chainApi.sends.length = 0;
  h.at(T0 + 601_000);
  h.vi.set(MARKET, { vi: 412.35, state: 'live', updatedAt: new Date(T0 - 60 * 60_000).toISOString() });
  const r = await h.tick();
  assert.deepEqual(actions(r.logs), ['open-deferred']);
  assert.deepEqual(r.logs[0].detail, { reason: 'VI older than 30 minutes' });
  assert.deepEqual(h.chainApi.sends, []);
});

test('tick: past the deadline nothing starts', async (t) => {
  const h = setup(t);
  await startNear(h);
  h.at(T0 + 601_000);
  h.freshVi(MARKET, 412.35);
  h.chainApi.sends.length = 0;
  const r = await h.tick({ deadline: Date.now() - 1 });
  assert.deepEqual(actions(r.logs), ['rounds-deadline']);
  assert.deepEqual(h.chainApi.sends, []);
});

test('tick: a pending series (a start that died) is created on chain, or adopted when it is there', async (t) => {
  const h = setup(t);
  const ref1 = `${MARKET.replace(/-/g, '')}01000000000000000000000000000001`;
  const ref2 = `${OTHER_MARKET.replace(/-/g, '')}01000000000000000000000000000002`;
  const fresh = h.store.addSeries({ chain: NEAR, reference: ref1, state: 'pending' });
  const adopted = h.store.addSeries({ chain: NEAR, reference: ref2, state: 'pending', atnx_market_id: OTHER_MARKET });
  await h.chainApi.createSeries({ reference: ref2, roundSecs: 3600, settleWindowSecs: 900, ante: 10n * U, finder: 'alice.testnet' });
  h.chainApi.sends.length = 0;

  let r = await h.tick();
  assert.deepEqual(actions(r.logs), [], 'younger than the grace period');
  h.at(T0 + 3 * 60_000);
  r = await h.tick();
  assert.deepEqual(actions(r.logs).sort(), ['series-adopted', 'series-created']);
  assert.deepEqual(h.chainApi.methods(), ['create_series']);
  const a = h.store.series.get(fresh.id)!;
  const b = h.store.series.get(adopted.id)!;
  assert.deepEqual([a.state, a.onchain_series_id, a.create_tx], ['active', 2, 'tx2-create_series']);
  assert.deepEqual([b.state, b.onchain_series_id], ['active', 1]);
  assert.equal(h.store.roundOf(fresh.id, 1)!.opens_at, new Date(T0 + 3 * 60_000 + 600_000).toISOString());
  assert.equal(h.store.roundOf(adopted.id, 1)!.opens_at, new Date(T0 + 600_000).toISOString());
});

test('tick: the NEAR step touches NEAR rows only', async (t) => {
  const h = setup(t);
  const sol = h.store.addSeries({ chain: 'solana:devnet', reference: 'cd'.repeat(32), state: 'paused', program_id: '5PsY', series_pubkey: 'PDA' });
  await h.reg.insertPresale(sol.id, 1, new Date(T0 - 1000), 'PDA1');
  h.store.addSeries({ chain: 'solana:devnet', reference: 'ef'.repeat(32), state: 'pending' });
  h.at(T0 + 3 * 60_000);
  const before = h.store.snapshot();
  const r = await h.tick();
  assert.deepEqual(actions(r.logs), []);
  assert.deepEqual(h.chainApi.sends, []);
  assert.equal(h.store.snapshot(), before);
});

test('nearChain: a registry id the chain disagrees with is an error, not a write', async (t) => {
  const h = setup(t);
  const { series } = await startNear(h);
  await h.reg.updateSeries(series.id, { onchain_series_id: 99 });
  h.at(T0 + 601_000);
  h.freshVi(MARKET, 412.35);
  h.chainApi.sends.length = 0;
  const r = await h.tick();
  assert.deepEqual(actions(r.logs), ['open']);
  assert.match(String(r.logs[0].error), /registry says series 99/);
  assert.equal(r.rep.errors, 1);
  assert.deepEqual(h.chainApi.sends, []);
  await assert.rejects(nearChain(h.chainApi).settle(series, 1, 1n, null), /needs the oracle commitment/);
});

// A chain without commitments (the shape the Solana adapter has): settle
// gets no commitment and the registry keeps no inputs.
test('tick: on a chain without commitments the settle carries none and no inputs are stored', async (t) => {
  const h = setup(t);
  const settles: (string | null)[] = [];
  const base = nearChain(h.chainApi);
  const plain: RoundsChain<NearChainSeries> = {
    ...base,
    key: 'solana:devnet',
    commitsInputs: false,
    roundKey: (_s, idx) => `PDA-round-${idx}`,
    activePatch: () => ({ series_pubkey: 'PDA-series' }),
    async createSeries(a) {
      const res = await base.createSeries(a);
      return { ...res, active: { series_pubkey: 'PDA-series' }, firstRoundKey: 'PDA-round-1' };
    },
    async openRound(series, idx, targetE2) {
      const res = await base.openRound(series, idx, targetE2);
      return { ...res, nextRoundKey: `PDA-round-${idx + 1}` };
    },
    async settle(series, idx, settleE2, commitment) {
      settles.push(commitment);
      return base.settle(series, idx, settleE2, ZERO_COMMITMENT);
    },
    parseFinder: (w) => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w) ? w : null),
    programId: () => '5PsYwtsaexsFLGz6pwnVAtBTLzRqmGHxQJFnYWv42aQX',
  };
  h.freshVi(MARKET, 100);
  const started = await startSeriesOn(plain, { atnxMarketId: MARKET, finderWallet: '5a5yfYQBX3QYqWZ55agFTHQoxg5Lc4TvT8g3roMfqa2S', fast: true }, h.deps);
  assert.ok(started.ok && !('dry' in started));
  const series = (started as { series: BmSeriesRow }).series;
  assert.deepEqual([series.chain, series.series_pubkey, series.onchain_series_id ?? null], ['solana:devnet', 'PDA-series', null]);
  assert.equal(h.store.roundOf(series.id, 1)!.round_pubkey, 'PDA-round-1');

  h.at(T0 + 601_000);
  h.freshVi(MARKET, 100);
  await h.tick({ chain: plain });
  const close = h.chainApi.rounds.get('1:1')!.closeAt;
  h.prints.set(MARKET, [
    { vi: 100, recorded_at: new Date((close - 10) * 1000).toISOString() },
    { vi: 100.02, recorded_at: new Date((close - 20) * 1000).toISOString() },
  ]);
  h.at(close * 1000 + 301_000);
  h.vi.delete(MARKET);
  const r = await h.tick({ chain: plain });
  assert.deepEqual(actions(r.logs).slice(0, 1), ['settled']);
  assert.deepEqual(settles, [null]);
  assert.deepEqual(r.logs[0].detail, { avg: 100.01, prints: 2, target: 100, winner: 'up' });
  const row = h.store.roundOf(series.id, 1)!;
  assert.equal('settle_inputs' in row, false);
  assert.equal('settle_commitment' in row, false);
  assert.equal(row.round_pubkey, 'PDA-round-1');
  assert.equal(h.store.roundOf(series.id, 2)!.round_pubkey, 'PDA-round-2');
});

// ------------------------------------------ starting from the site (NEAR)

test('startNearSeries: validates like the Solana start, then creates with the keeper', async (t) => {
  const h = setup(t);
  const { startNearSeries } = await import('./rounds-near');
  const chain = nearChain(h.chainApi);
  const dev = { NODE_ENV: 'development' };
  assert.deepEqual(await startNearSeries({ marketId: 'not-a-uuid', finder: 'alice.testnet' }, { chain, deps: h.deps, env: dev }), {
    ok: false,
    error: 'Bad request',
    code: 'not_found',
  });
  assert.deepEqual(await startNearSeries({ marketId: MARKET, finder: 'Alice' }, { chain, deps: h.deps, env: dev }), { ok: false, error: 'bad wallet', code: 'chain' });
  assert.equal(h.store.writes, 0);

  h.vi.set(MARKET, { vi: 412.35, state: 'scoring', updatedAt: new Date().toISOString() });
  const scoring = await startNearSeries({ marketId: MARKET, finder: 'alice.testnet' }, { chain, deps: h.deps, env: dev });
  assert.equal(!scoring.ok && scoring.code, 'scoring');

  h.freshVi(MARKET, 412.35);
  const res = await startNearSeries({ marketId: MARKET, finder: ' alice.testnet ' }, { chain, deps: h.deps, env: dev });
  assert.ok(res.ok && !('dry' in res), JSON.stringify(res));
  const { series, round } = res as { series: BmSeriesRow; round: BmRoundRow };
  assert.deepEqual(
    [series.chain, series.state, series.finder_wallet, series.fast, series.onchain_series_id, series.round_secs, round.idx, round.state],
    [NEAR, 'active', 'alice.testnet', false, 1, 86400, 1, 'presale']
  );
  assert.deepEqual(h.chainApi.methods(), ['create_series']);
  assert.equal(h.chainApi.sends[0].args.finder, 'alice.testnet');

  const again = await startNearSeries({ marketId: MARKET, finder: 'bob.testnet' }, { chain, deps: h.deps, env: dev });
  assert.deepEqual(again, { ok: false, error: 'Rounds are already running on this market', code: 'already_active' });
});

test('startNearSeries: a fast series from a production build only with BM_FAST_FROM_CLIENT=1', async (t) => {
  const h = setup(t);
  const { startNearSeries, fastFromSiteAllowed } = await import('./rounds-near');
  assert.equal(fastFromSiteAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(fastFromSiteAllowed({ NODE_ENV: 'production', BM_FAST_FROM_CLIENT: '1' }), true);
  assert.equal(fastFromSiteAllowed({ NODE_ENV: 'development' }), true);
  const chain = nearChain(h.chainApi);
  h.freshVi(MARKET, 412.35);
  h.freshVi(OTHER_MARKET, 99);

  const prod = await startNearSeries({ marketId: MARKET, finder: 'alice.testnet', fast: true }, { chain, deps: h.deps, env: { NODE_ENV: 'production' } });
  assert.ok(prod.ok && !('dry' in prod));
  assert.equal((prod as { series: BmSeriesRow }).series.fast, false, 'asked fast, got daily');
  assert.equal((prod as { series: BmSeriesRow }).series.round_secs, 86400);

  const allowed = await startNearSeries(
    { marketId: OTHER_MARKET, finder: 'alice.testnet', fast: true },
    { chain, deps: h.deps, env: { NODE_ENV: 'production', BM_FAST_FROM_CLIENT: '1' } }
  );
  assert.ok(allowed.ok && !('dry' in allowed));
  assert.equal((allowed as { series: BmSeriesRow }).series.fast, true);
  assert.equal((allowed as { series: BmSeriesRow }).series.round_secs, 3600);
});

test('startNearSeries: without the keeper key nothing is reserved', async (t) => {
  const h = setup(t);
  const { startNearSeries } = await import('./rounds-near');
  const before = { account: process.env.BM_NEAR_KEEPER_ACCOUNT, secret: process.env.BM_NEAR_KEEPER_SECRET };
  delete process.env.BM_NEAR_KEEPER_ACCOUNT;
  delete process.env.BM_NEAR_KEEPER_SECRET;
  try {
    h.freshVi(MARKET, 412.35);
    const res = await startNearSeries({ marketId: MARKET, finder: 'alice.testnet' }, { deps: h.deps });
    assert.deepEqual(res, { ok: false, error: 'Rounds are not live on NEAR testnet yet', code: 'chain' });
    assert.equal(h.store.writes, 0);
  } finally {
    if (before.account !== undefined) process.env.BM_NEAR_KEEPER_ACCOUNT = before.account;
    if (before.secret !== undefined) process.env.BM_NEAR_KEEPER_SECRET = before.secret;
  }
});
