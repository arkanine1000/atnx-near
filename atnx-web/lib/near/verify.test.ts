import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettleInputs, settleCommitment, type SettleInputs } from '../bm/commitment';
import { parseRound, parseSeries } from '../bm/near';
import { PublicVerifyError, checkAgainstChain, handleSettled, handleVerify, rpcView, verifyFromSite, type FetchFn, type SettledRoundRecord, type VerifyRecord } from './verify';

// ------------------------------------------------------------- fixtures

const RPC = 'https://rpc.example';
const SITE = 'https://site.example';
const CONTRACT = 'rounds.atnx.testnet';
const MARKET = '46a8890c-25ce-4231-9112-fc1b3ba8ac07';
const REFERENCE = 'ab'.repeat(32);
const CLOSE = 1_762_655_351; // unix seconds
const WINDOW = 720;

function inputsFor(roundIndex: number, vis = [1071.5, 1071.88]): SettleInputs {
  const rows = vis.map((vi, i) => ({ vi, recorded_at: new Date((CLOSE - 600 + i * 300) * 1000).toISOString() }));
  return buildSettleInputs({ marketId: MARKET, reference: REFERENCE, roundIndex, closeAt: CLOSE, windowSecs: WINDOW, rows })!;
}

function roundJson(index: number, commitment: string, settleE2: number, state = 'Settled') {
  return {
    series_id: 9,
    index,
    state,
    winner: 'Up',
    presale_up: '0',
    presale_down: '0',
    m_up: '1',
    m_down: '1',
    n_up: '1',
    n_down: '1',
    opened_at: CLOSE - 1200,
    close_at: CLOSE,
    trade_until: CLOSE - WINDOW,
    target_e2: 107082,
    settle_e2: settleE2,
    commitment,
    paid_out: '0',
  };
}

function seriesJson(reference = REFERENCE) {
  return {
    id: 9,
    finder: 'atnx.testnet',
    reference,
    round_secs: 1200,
    settle_window_secs: WINDOW,
    fee_bps: 100,
    finder_bps: 2000,
    ante: '0',
    paused: false,
    live_round: 0,
    presale_round: 3,
    finder_fees: '0',
    platform_fees: '0',
  };
}

// jsonb hands keys back in its own order (shorter keys first, then by bytes).
function asJsonb(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(asJsonb);
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1));
    return Object.fromEntries(entries.map(([k, x]) => [k, asJsonb(x)]));
  }
  return v;
}

const bytes = (v: unknown) => Array.from(Buffer.from(v === undefined ? '' : JSON.stringify(v), 'utf8'));

interface FakeWorld {
  // On-chain views by "method:args".
  views: Map<string, unknown>;
  // Site answers by path + query.
  site: Map<string, { status: number; body: unknown }>;
  calls: string[];
}

function fakeFetch(w: FakeWorld): FetchFn {
  return async (url, init) => {
    if (url === RPC) {
      const req = JSON.parse(init!.body!) as { method: string; params: { request_type: string; finality: string; account_id: string; method_name: string; args_base64: string } };
      assert.equal(req.method, 'query');
      assert.equal(req.params.request_type, 'call_function');
      assert.equal(req.params.finality, 'final');
      assert.equal(req.params.account_id, CONTRACT);
      const args = Buffer.from(req.params.args_base64, 'base64').toString('utf8');
      const key = `${req.params.method_name}:${args}`;
      w.calls.push(`rpc ${key}`);
      if (!w.views.has(key)) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { result: bytes(null) } }) };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { result: bytes(w.views.get(key)) } }) };
    }
    const path = url.slice(SITE.length);
    w.calls.push(`site ${path}`);
    const hit = w.site.get(path) ?? { status: 404, body: { error: 'not_found' } };
    return { ok: hit.status < 400, status: hit.status, json: async () => hit.body };
  };
}

// Round 2 settled on chain with the commitment of its inputs.
function settledWorld() {
  const inputs = inputsFor(2);
  const { hash } = settleCommitment(inputs);
  const w: FakeWorld = { views: new Map(), site: new Map(), calls: [] };
  w.views.set('get_round:{"series_id":9,"round_index":2}', roundJson(2, hash, inputs.average_e2));
  w.views.set('get_series:{"series_id":9}', seriesJson());
  return { inputs, hash, w };
}

// ------------------------------------------------------------------ RPC

test('rpcView: one call_function query at final, the args as base64 JSON, the result decoded', async () => {
  const { w } = settledWorld();
  const f = fakeFetch(w);
  const r = (await rpcView(f, RPC, CONTRACT, 'get_series', { series_id: 9 })) as { reference: string };
  assert.equal(r.reference, REFERENCE);
  assert.equal(await rpcView(f, RPC, CONTRACT, 'get_series', { series_id: 99 }), null);
  const failing: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({ result: { error: 'wasm execution failed' } }) });
  await assert.rejects(rpcView(failing, RPC, CONTRACT, 'get_round', {}), /wasm execution failed/);
  const down: FetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(rpcView(down, RPC, CONTRACT, 'get_round', {}), /HTTP 503/);
  const rpcErr: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({ error: { name: 'HANDLER_ERROR' } }) });
  await assert.rejects(rpcView(rpcErr, RPC, CONTRACT, 'get_round', {}), /HANDLER_ERROR/);
});

// --------------------------------------------------------------- verify

test('checkAgainstChain: the inputs as stored (keys reordered by jsonb) hash to the commitment', () => {
  const { inputs, hash } = settledWorld();
  const round = parseRound(roundJson(2, hash, inputs.average_e2));
  const series = parseSeries(seriesJson());
  const c = checkAgainstChain(asJsonb(inputs), round, series, 2);
  assert.equal(c.match, true);
  assert.equal(c.ok, true, c.problems.join('; '));
  assert.equal(c.recomputed, hash);
  assert.equal(c.canonical, settleCommitment(inputs).json);
});

test('checkAgainstChain: a changed print, another round, another series, or no inputs do not pass', () => {
  const { inputs, hash } = settledWorld();
  const round = parseRound(roundJson(2, hash, inputs.average_e2));
  const series = parseSeries(seriesJson());

  const tampered = structuredClone(inputs);
  tampered.prints[0].vi += 0.01;
  const t = checkAgainstChain(tampered, round, series, 2);
  assert.equal(t.match, false);
  assert.equal(t.ok, false);
  assert.ok(t.problems.some((p) => /average of the prints/.test(p)));

  // Round 3's inputs offered for round 2.
  const other = checkAgainstChain(inputsFor(3), round, series, 2);
  assert.equal(other.match, false);
  assert.ok(other.problems.some((p) => /round 3 is not 2/.test(p)));

  // The right hash, but the chain says the series has another reference.
  const elsewhere = checkAgainstChain(inputs, round, parseSeries(seriesJson('cd'.repeat(32))), 2);
  assert.equal(elsewhere.match, true);
  assert.equal(elsewhere.ok, false);
  assert.ok(elsewhere.problems.some((p) => /reference/.test(p)));

  const none = checkAgainstChain(null, round, series, 2);
  assert.equal(none.ok, false);
  assert.deepEqual(none.problems, ['no settle inputs']);

  const notSettled = checkAgainstChain(inputs, parseRound(roundJson(2, hash, inputs.average_e2, 'Live')), series, 2);
  assert.equal(notSettled.ok, false);
});

// --------------------------------------------------------------- routes

function record(over: Partial<VerifyRecord> = {}): VerifyRecord {
  const { inputs, hash } = settledWorld();
  return {
    onchainSeriesId: 9,
    roundIndex: 2,
    marketId: MARKET,
    marketName: 'Example market',
    targetVi: 1070.82,
    settleVi: 1071.69,
    settlePrints: 2,
    winner: 'up',
    settleTx: 'SETTLETX',
    closeAt: new Date(CLOSE * 1000).toISOString(),
    settleCommitment: hash,
    state: 'settled',
    settleInputs: asJsonb(inputs),
    ...over,
  };
}

test('settled route: the latest settled rounds with how to verify each; the limit is checked', async () => {
  const rows: SettledRoundRecord[] = [record(), { ...record(), roundIndex: 1, marketName: null }];
  let asked = 0;
  const deps = { listSettled: async (n: number) => ((asked = n), rows), contractId: CONTRACT };
  const r = await handleSettled(deps, new URLSearchParams(''));
  assert.equal(r.status, 200);
  assert.equal(asked, 20);
  const items = r.body.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.deepEqual(
    { series: items[0].series, round: items[0].round, market: items[0].market, target: items[0].target, settleAverage: items[0].settleAverage, winner: items[0].winner, settleTx: items[0].settleTx },
    { series: 9, round: 2, market: 'Example market', target: 1070.82, settleAverage: 1071.69, winner: 'up', settleTx: 'SETTLETX' },
  );
  assert.equal(items[0].settleTxUrl, 'https://testnet.nearblocks.io/txns/SETTLETX');
  assert.equal(items[0].verify, '/api/near/rounds/verify?series=9&round=2');
  assert.equal(items[0].verifyLocally, 'npm run rounds:verify:public -- 9 2');
  assert.equal(items[1].market, 'Unknown market');
  await handleSettled(deps, new URLSearchParams('limit=5'));
  assert.equal(asked, 5);
  for (const bad of ['0', '51', 'x', '-1', '1.5']) assert.equal((await handleSettled(deps, new URLSearchParams(`limit=${bad}`))).status, 400, bad);
});

test('verify route: registry inputs, the live on-chain commitment, the hash recomputed, match', async () => {
  const { hash, w } = settledWorld();
  const deps = { findRound: async (s: number, r: number) => (s === 9 && r === 2 ? record() : null), chain: { fetch: fakeFetch(w), rpcUrl: RPC, contractId: CONTRACT } };
  const r = await handleVerify(deps, new URLSearchParams('series=9&round=2'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.match, true);
  assert.equal(r.body.registryMatch, true);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.recomputed, hash);
  assert.equal(r.body.registryCommitment, hash);
  assert.equal((r.body.onchain as { commitment: string }).commitment, hash);
  // The inputs come back in canonical key order, and their canonical form is what was hashed.
  assert.deepEqual(Object.keys(r.body.settleInputs as object), ['average_e2', 'market_id', 'prints', 'round_index', 'series_reference', 'version', 'window_end', 'window_start']);
  assert.equal(r.body.canonical, settleCommitment(inputsFor(2)).json);
  assert.ok(w.calls.includes('rpc get_round:{"series_id":9,"round_index":2}'), 'the commitment was read from the chain');

  // The registry's hash disagreeing with the chain shows.
  const lying = await handleVerify({ ...deps, findRound: async () => record({ settleCommitment: '0'.repeat(64) }) }, new URLSearchParams('series=9&round=2'));
  assert.equal(lying.body.match, true);
  assert.equal(lying.body.registryMatch, false);
  assert.equal(lying.body.ok, false);
});

test('verify route: bad parameters, not in the registry, not settled, not on chain', async () => {
  const { w } = settledWorld();
  const chain = { fetch: fakeFetch(w), rpcUrl: RPC, contractId: CONTRACT };
  for (const q of ['', 'series=9', 'round=2', 'series=0&round=2', 'series=9&round=-1', 'series=x&round=2', 'series=99999999999&round=1']) {
    assert.equal((await handleVerify({ findRound: async () => record(), chain }, new URLSearchParams(q))).status, 400, q);
  }
  assert.equal((await handleVerify({ findRound: async () => null, chain }, new URLSearchParams('series=9&round=2'))).body.error, 'not_in_registry');
  const live = await handleVerify({ findRound: async () => record({ state: 'live' }), chain }, new URLSearchParams('series=9&round=2'));
  assert.equal(live.status, 409);
  assert.equal(live.body.state, 'live');
  assert.equal((await handleVerify({ findRound: async () => record({ roundIndex: 5 }), chain }, new URLSearchParams('series=9&round=5'))).body.error, 'not_on_chain');
});

// --------------------------------------------------------------- script

function siteAnswers(w: FakeWorld, settleInputs: unknown, claims: { recomputed?: string; match?: boolean } = {}) {
  w.site.set('/api/near/rounds/verify?series=9&round=2', { status: 200, body: { series: 9, round: 2, market: { name: 'Example market' }, settleInputs, recomputed: claims.recomputed ?? null, match: claims.match ?? null } });
  w.site.set('/api/near/rounds/settled?limit=1', { status: 200, body: { items: [{ series: 9, round: 2 }] } });
}

const opts = (w: FakeWorld, series: number | null = 9, round: number | null = 2) => ({ site: SITE, rpcUrl: RPC, contractId: CONTRACT, series, round, fetch: fakeFetch(w) });

test('script: honest inputs pass; the commitment comes from the RPC, the hash from here', async () => {
  const { inputs, hash, w } = settledWorld();
  siteAnswers(w, asJsonb(inputs), { recomputed: hash, match: true });
  const r = await verifyFromSite(opts(w));
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.recomputed, hash);
  assert.equal(r.onchainCommitment, hash);
  assert.equal(r.prints, 2);
  assert.equal(r.marketName, 'Example market');
  assert.ok(w.calls.includes('rpc get_round:{"series_id":9,"round_index":2}'));
  assert.ok(w.calls.includes('rpc get_series:{"series_id":9}'));
});

test("script: never trusts the site's hash or verdict", async () => {
  const { inputs, hash, w } = settledWorld();
  // Tampered inputs, while the site claims they match.
  const tampered = structuredClone(inputs);
  tampered.prints[1].vi = 2000;
  siteAnswers(w, tampered, { recomputed: hash, match: true });
  const bad = await verifyFromSite(opts(w));
  assert.equal(bad.ok, false);
  assert.equal(bad.match, false);
  assert.equal(bad.siteMatch, true, 'the claim is reported, not used');
  assert.ok(bad.problems.some((p) => /not the on-chain commitment/.test(p)));

  // Honest inputs, while the site claims a mismatch and gives a wrong hash.
  siteAnswers(w, inputs, { recomputed: 'f'.repeat(64), match: false });
  const good = await verifyFromSite(opts(w));
  assert.equal(good.ok, true);
  assert.equal(good.siteRecomputed, 'f'.repeat(64));

  // Another round's inputs, honestly hashed, offered as round 2's.
  siteAnswers(w, inputsFor(3), { recomputed: settleCommitment(inputsFor(3)).hash, match: true });
  assert.equal((await verifyFromSite(opts(w))).ok, false);
});

test('script: with no series and round it takes the latest settled one; a missing round is an error', async () => {
  const { inputs, w } = settledWorld();
  siteAnswers(w, inputs);
  const r = await verifyFromSite(opts(w, null, null));
  assert.equal(r.series, 9);
  assert.equal(r.round, 2);
  assert.equal(r.ok, true);
  assert.ok(w.calls.includes('site /api/near/rounds/settled?limit=1'));
  await assert.rejects(verifyFromSite(opts(w, 9, 7)), PublicVerifyError);
  w.site.clear();
  await assert.rejects(verifyFromSite(opts(w, null, null)), PublicVerifyError);
});
