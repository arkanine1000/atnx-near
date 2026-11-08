import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZERO_COMMITMENT,
  averageE2,
  buildSettleInputs,
  canonicalJson,
  canonicalTimestamp,
  settleCommitment,
  sha256Hex,
  sortPrints,
  verifySettleInputs,
  type SettleInputs,
} from './commitment';
import { settlementFrom } from './rounds-core';
import { averageVi, toE2 } from './settle';

// ------------------------------------------------------- canonical JSON

test('canonicalJson: keys sorted at every level, arrays kept in order, no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: 'x' } }), '{"a":{"c":"x","d":[3,1,2]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
});

test('canonicalJson: keys compare by UTF-16 code units, as RFC 8785 does', () => {
  assert.equal(canonicalJson({ b: 0, B: 0, a: 0, _: 0, '1': 0 }), '{"1":0,"B":0,"_":0,"a":0,"b":0}');
  assert.equal(canonicalJson({ é: 1, z: 2 }), '{"z":2,"é":1}');
});

test('canonicalJson: numbers and strings as JSON.stringify writes them', () => {
  assert.equal(canonicalJson(412.35), '412.35');
  assert.equal(canonicalJson(0.1 + 0.2), '0.30000000000000004');
  assert.equal(canonicalJson(1e-7), '1e-7');
  assert.equal(canonicalJson(1e21), '1e+21');
  assert.equal(canonicalJson(-0), '0');
  assert.equal(canonicalJson(100), '100');
  assert.equal(canonicalJson('a"b\\c\n\u0001é'), JSON.stringify('a"b\\c\n\u0001é'));
});

test('canonicalJson: refuses what JSON cannot carry exactly', () => {
  assert.throws(() => canonicalJson(Number.NaN));
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson(10n));
  assert.throws(() => canonicalJson(new Date(0)));
  assert.throws(() => canonicalJson(() => 1));
});

test('sha256Hex: the standard vectors, lowercase hex', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // UTF-8, not UTF-16.
  assert.equal(sha256Hex('é'), sha256Hex(Buffer.from([0xc3, 0xa9]).toString('utf8')));
});

// ----------------------------------------------------------- timestamps

test('canonicalTimestamp: PostgREST and Postgres forms to UTC with six digits', () => {
  assert.equal(canonicalTimestamp('2026-11-08T16:20:59.25021+00:00'), '2026-11-08T16:20:59.250210Z');
  assert.equal(canonicalTimestamp('2026-11-08T16:20:59.584105+00:00'), '2026-11-08T16:20:59.584105Z');
  assert.equal(canonicalTimestamp('2026-11-08 17:20:01+01'), '2026-11-08T16:20:01.000000Z');
  assert.equal(canonicalTimestamp('2026-11-08T21:50:01.5+05:30'), '2026-11-08T16:20:01.500000Z');
  assert.equal(canonicalTimestamp('2026-11-08T16:20:01Z'), '2026-11-08T16:20:01.000000Z');
  assert.equal(canonicalTimestamp('2026-11-08T16:20:01.000Z'), '2026-11-08T16:20:01.000000Z');
  assert.equal(canonicalTimestamp('2026-11-08T16:20:01'), '2026-11-08T16:20:01.000000Z');
  assert.equal(canonicalTimestamp('2026-11-08T16:20:01.123456789Z'), '2026-11-08T16:20:01.123456Z');
});

test('canonicalTimestamp: offsets move across midnight and month ends', () => {
  assert.equal(canonicalTimestamp('2026-11-08T00:30:00+01:00'), '2026-11-07T23:30:00.000000Z');
  assert.equal(canonicalTimestamp('2026-11-30T23:30:00-01:00'), '2026-12-01T00:30:00.000000Z');
});

test('canonicalTimestamp: a Date keeps its milliseconds', () => {
  assert.equal(canonicalTimestamp(new Date('2026-11-08T16:20:59.250Z')), '2026-11-08T16:20:59.250000Z');
  assert.equal(canonicalTimestamp(new Date(0)), '1970-01-01T00:00:00.000000Z');
  assert.equal(canonicalTimestamp(new Date(1794160800 * 1000)), '2026-11-08T18:00:00.000000Z');
});

test('canonicalTimestamp: refuses what it cannot read', () => {
  assert.throws(() => canonicalTimestamp('yesterday'));
  assert.throws(() => canonicalTimestamp('2026-11-08'));
  assert.throws(() => canonicalTimestamp(new Date('nope')));
});

test('canonical timestamps sort chronologically as strings', () => {
  const a = canonicalTimestamp('2026-11-08T16:20:59.9+00:00');
  const b = canonicalTimestamp('2026-11-08T16:21:00.000001+00:00');
  const c = canonicalTimestamp('2026-11-08 18:21:00+01');
  assert.ok(a < b && b < c);
});

// ---------------------------------------------------------------- inputs

const MARKET = '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
const REF = '0f1e2d3c4b5a69788796a5b4c3d2e1f00100000000000000000000006af0a77d';
const CLOSE = 1794160800; // 2026-11-08T18:00:00Z
const ROWS = [
  { vi: 412.36, recorded_at: '2026-11-08T17:59:00.5+00:00' },
  { vi: 412.3, recorded_at: '2026-11-08T17:31:00.123456+00:00' },
  { vi: '412.31', recorded_at: '2026-11-08 18:45:00+01' },
];

function golden(): SettleInputs {
  return buildSettleInputs({ marketId: MARKET, reference: REF, roundIndex: 12, closeAt: CLOSE, windowSecs: 1800, rows: ROWS })!;
}

test('buildSettleInputs: the fields, prints sorted and canonical, the average as posted', () => {
  const s = golden();
  assert.deepEqual(s, {
    version: 1,
    market_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    series_reference: REF,
    round_index: 12,
    window_start: '2026-11-08T17:30:00.000000Z',
    window_end: '2026-11-08T18:00:00.000000Z',
    prints: [
      { at: '2026-11-08T17:31:00.123456Z', vi: 412.3 },
      { at: '2026-11-08T17:45:00.000000Z', vi: 412.31 },
      { at: '2026-11-08T17:59:00.500000Z', vi: 412.36 },
    ],
    average_e2: 41232,
  });
  assert.equal(s.average_e2, Number(toE2(averageVi(s.prints)!)));
});

// Pinned: a change here means every stored commitment stops verifying.
// Cross-checked with `printf '%s' "$json" | sha256sum`.
test('settleCommitment: the golden vector', () => {
  const { json, hash } = settleCommitment(golden());
  assert.equal(
    json,
    '{"average_e2":41232,"market_id":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0","prints":[{"at":"2026-11-08T17:31:00.123456Z","vi":412.3},{"at":"2026-11-08T17:45:00.000000Z","vi":412.31},{"at":"2026-11-08T17:59:00.500000Z","vi":412.36}],"round_index":12,"series_reference":"0f1e2d3c4b5a69788796a5b4c3d2e1f00100000000000000000000006af0a77d","version":1,"window_end":"2026-11-08T18:00:00.000000Z","window_start":"2026-11-08T17:30:00.000000Z"}'
  );
  assert.equal(hash, '51b41afafd4e97b35423dd05592eaa66c2e44e37a0b122bd06825133fe9c4d69');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, ZERO_COMMITMENT);
});

test('buildSettleInputs: the order of the rows does not matter', () => {
  const a = settleCommitment(golden()).hash;
  const b = settleCommitment(buildSettleInputs({ marketId: MARKET, reference: REF.toUpperCase(), roundIndex: 12, closeAt: CLOSE, windowSecs: 1800, rows: [...ROWS].reverse() })!).hash;
  assert.equal(a, b);
});

test('sortPrints: by time, then by VI for prints at the same time', () => {
  const sorted = sortPrints([
    { at: '2026-11-08T17:00:00.000000Z', vi: 5 },
    { at: '2026-11-08T16:00:00.000000Z', vi: 9 },
    { at: '2026-11-08T17:00:00.000000Z', vi: 1 },
  ]);
  assert.deepEqual(sorted.map((p) => p.vi), [9, 1, 5]);
});

test('buildSettleInputs: no rows is no inputs; bad rows are refused', () => {
  assert.equal(buildSettleInputs({ marketId: MARKET, reference: REF, roundIndex: 1, closeAt: CLOSE, windowSecs: 60, rows: [] }), null);
  assert.throws(() => buildSettleInputs({ marketId: MARKET, reference: REF, roundIndex: 1, closeAt: CLOSE, windowSecs: 60, rows: [{ vi: 'x', recorded_at: '2026-11-08T17:59:00Z' }] }));
  assert.throws(() => buildSettleInputs({ marketId: MARKET, reference: 'abc', roundIndex: 1, closeAt: CLOSE, windowSecs: 60, rows: ROWS }));
  assert.throws(() => buildSettleInputs({ marketId: 'nope', reference: REF, roundIndex: 1, closeAt: CLOSE, windowSecs: 60, rows: ROWS }));
  assert.throws(() => buildSettleInputs({ marketId: MARKET, reference: REF, roundIndex: 0, closeAt: CLOSE, windowSecs: 60, rows: ROWS }));
  assert.throws(() => averageE2([]));
});

test('settlementFrom: without commitments, the plain mean in the order given (Solana)', () => {
  const s = settlementFrom([{ vi: 100, recorded_at: 'x' }, { vi: 200, recorded_at: 'y' }], null);
  assert.deepEqual(s, { avg: 150, prints: 2, inputs: null, commitment: null });
  assert.deepEqual(settlementFrom([], null), { avg: null, prints: 0, inputs: null, commitment: null });
});

test('settlementFrom: with commitments, the inputs, their hash and the same average', () => {
  const s = settlementFrom(ROWS, { marketId: MARKET, reference: REF, roundIndex: 12, closeAt: CLOSE, windowSecs: 1800 });
  assert.equal(s.avg, 412.32);
  assert.equal(s.prints, 3);
  assert.deepEqual(s.inputs, golden());
  assert.equal(s.commitment, settleCommitment(golden()).hash);
  assert.deepEqual(settlementFrom([], { marketId: MARKET, reference: REF, roundIndex: 12, closeAt: CLOSE, windowSecs: 1800 }), {
    avg: null,
    prints: 0,
    inputs: null,
    commitment: null,
  });
});

// ----------------------------------------------------------------- verify

const onChain = () => ({ commitment: settleCommitment(golden()).hash, settleE2: 41232n, closeAt: CLOSE });
const expect = { marketId: MARKET, reference: REF, roundIndex: 12, windowSecs: 1800 };

// What jsonb hands back: the same content, keys in another order.
function shuffledKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shuffledKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffledKeys(x)]));
  }
  return v;
}

test('verifySettleInputs: stored inputs read back in jsonb key order still verify', () => {
  const back = JSON.parse(JSON.stringify(shuffledKeys(golden())));
  assert.notEqual(JSON.stringify(back), canonicalJson(golden()));
  const res = verifySettleInputs(back, onChain(), expect);
  assert.deepEqual(res, { ok: true, hash: onChain().commitment, problems: [] });
});

test('verifySettleInputs: a changed print breaks the hash', () => {
  const t = golden();
  t.prints[0].vi = 412.29;
  const res = verifySettleInputs(t, onChain(), expect);
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.startsWith('hash ')));
});

test('verifySettleInputs: an average that does not follow from the prints', () => {
  const t = golden();
  t.average_e2 = 41300;
  const chain = { ...onChain(), commitment: settleCommitment(t).hash, settleE2: 41300n };
  const res = verifySettleInputs(t, chain, expect);
  assert.equal(res.ok, false);
  assert.deepEqual(res.problems, ['average of the prints is 41232 (e2), the inputs say 41300']);
});

test('verifySettleInputs: the wrong round, window, order or settle_e2', () => {
  const g = golden();
  const chain = onChain();
  assert.ok(verifySettleInputs(g, { ...chain, settleE2: 41231n }, expect).problems.some((p) => p.includes('settle_e2')));
  assert.ok(verifySettleInputs(g, { ...chain, closeAt: CLOSE + 60 }, expect).problems.some((p) => p.startsWith('window_end')));
  assert.ok(verifySettleInputs(g, chain, { ...expect, roundIndex: 11 }).problems.some((p) => p.startsWith('round 12')));
  assert.ok(verifySettleInputs(g, chain, { ...expect, windowSecs: 900 }).problems.some((p) => p.startsWith('window_start')));
  assert.ok(verifySettleInputs(g, chain, { ...expect, marketId: '00000000-0000-0000-0000-000000000000' }).problems.some((p) => p.startsWith('market')));
  const unsorted = { ...g, prints: [...g.prints].reverse() };
  const res = verifySettleInputs(unsorted, { ...chain, commitment: settleCommitment(unsorted as SettleInputs).hash }, expect);
  assert.ok(res.problems.includes('prints are not in canonical order'));
  const outside = { ...g, prints: [...g.prints, { at: '2026-11-08T18:00:00.000001Z', vi: 412.32 }] };
  assert.ok(
    verifySettleInputs(outside, { ...chain, commitment: settleCommitment(outside as SettleInputs).hash }, expect).problems.some((p) => p.includes('outside'))
  );
});

test('verifySettleInputs: nothing stored', () => {
  assert.deepEqual(verifySettleInputs(null, onChain()), { ok: false, hash: '', problems: ['no settle inputs stored'] });
  assert.equal(verifySettleInputs([1, 2], onChain()).ok, false);
});
