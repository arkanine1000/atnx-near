import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { QuoteIn } from './house-types';
import { buildQuoteBatch, printAtSecs, quoteCommitment, quoteFromRow, sortQuotesLike, verifyQuotePush, type PrintRow } from './quote-commitment';

const A = '46a8890c-25ce-4231-9112-fc1b3ba8ac07';
const B = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const REF_A = A.replace(/-/g, '');
const REF_B = B.replace(/-/g, '');

const ROWS: PrintRow[] = [
  { id: 905, market_id: A, vi: 455.51, raw_vi: 513, recorded_at: '2026-11-09T23:05:41.250210+00:00' },
  { id: 901, market_id: B.toUpperCase(), vi: 673.07, raw_vi: 711.2, recorded_at: '2026-11-09T23:05:40.1+00:00' },
];

// The canonical form, written out by hand: keys sorted, B before A (the
// uuids sort as strings), six fractional digits, numbers as JSON writes them.
const CANONICAL =
  '{"kind":"quotes","prints":[' +
  '{"at":"2026-11-09T23:05:40.100000Z","id":901,"market":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0","raw_vi":711.2,"vi":673.07},' +
  '{"at":"2026-11-09T23:05:41.250210Z","id":905,"market":"46a8890c-25ce-4231-9112-fc1b3ba8ac07","raw_vi":513,"vi":455.51}' +
  '],"version":2}';

test('buildQuoteBatch: the canonical JSON and its sha256 are fixed', () => {
  const { json, hash } = quoteCommitment(buildQuoteBatch(ROWS));
  assert.equal(json, CANONICAL);
  assert.equal(hash, createHash('sha256').update(CANONICAL, 'utf8').digest('hex'));
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('buildQuoteBatch: the same rows in any order give the same hash', () => {
  const h1 = quoteCommitment(buildQuoteBatch(ROWS)).hash;
  const h2 = quoteCommitment(buildQuoteBatch([...ROWS].reverse())).hash;
  // PostgREST's other spellings of the same values.
  const respelled = ROWS.map((r) => ({ ...r, id: String(r.id), vi: String(r.vi), recorded_at: r.recorded_at.replace('+00:00', 'Z') }));
  const h3 = quoteCommitment(buildQuoteBatch(respelled)).hash;
  assert.equal(h1, h2);
  assert.equal(h1, h3);
});

test('buildQuoteBatch: sorted by market, then by id', () => {
  const rows: PrintRow[] = [
    { id: 30, market_id: A, vi: 1, raw_vi: 1, recorded_at: '2026-11-09T23:00:00Z' },
    { id: 10, market_id: A, vi: 1, raw_vi: 1, recorded_at: '2026-11-09T23:00:00Z' },
    { id: 20, market_id: B, vi: 1, raw_vi: 1, recorded_at: '2026-11-09T23:00:00Z' },
  ];
  const prints = buildQuoteBatch(rows).prints;
  assert.deepEqual(
    prints.map((p) => [p.market, p.id]),
    [
      [B, 20],
      [A, 10],
      [A, 30],
    ]
  );
});

test('buildQuoteBatch: refuses a row without a reading or with a bad id', () => {
  assert.throws(() => buildQuoteBatch([{ ...ROWS[0], raw_vi: null }]), /raw_vi/);
  assert.throws(() => buildQuoteBatch([{ ...ROWS[0], id: 0 }]), /id/);
  assert.throws(() => buildQuoteBatch([{ ...ROWS[0], market_id: 'nope' }]), /uuid/);
});

test('quoteFromRow: toE2 of the score and the reading, print_at in whole seconds, read_at as given', () => {
  const q = quoteFromRow(ROWS[0], 7, 1_794_265_600);
  assert.deepEqual(q, {
    market: 7,
    scoreE2: 45551n,
    readingE2: 51300n,
    printId: 905n,
    printAt: Date.UTC(2026, 10, 9, 23, 5, 41) / 1000,
    readAt: 1_794_265_600,
  });
  // 0.1 + 0.2 style floats round to the cent, as toE2 does.
  assert.equal(quoteFromRow({ ...ROWS[0], vi: 100.005, raw_vi: 0.29 }, 1, 1_794_265_600).readingE2, 29n);
  assert.equal(printAtSecs('2026-11-09T23:05:41.999999+00:00'), Date.UTC(2026, 10, 9, 23, 5, 41) / 1000);
});

test('quoteFromRow: read_at is chain time and may be a little before the print\'s database time', () => {
  const at = printAtSecs(ROWS[0].recorded_at);
  assert.equal(quoteFromRow(ROWS[0], 7, at - 2).readAt, at - 2);
  assert.equal(quoteFromRow(ROWS[0], 7, at - 2).printAt, at);
  assert.throws(() => quoteFromRow(ROWS[0], 7, -1), /not a unix time/);
  assert.throws(() => quoteFromRow(ROWS[0], 7, 1.5), /not a unix time/);
});

function pushOf(rows: PrintRow[], markets: Record<string, number>, readAt = 1_794_265_600): { quotes: QuoteIn[]; commitment: string } {
  const uuidOf = (m: number) => Object.keys(markets).find((u) => markets[u] === m)!;
  const quotes = sortQuotesLike(
    rows.map((r) => quoteFromRow(r, markets[r.market_id.toLowerCase()], readAt)),
    uuidOf
  );
  return { quotes, commitment: quoteCommitment(buildQuoteBatch(rows)).hash };
}

const MARKETS = { [A]: 3, [B]: 1 };
const REFS = new Map([
  [3, REF_A],
  [1, REF_B],
]);

test('verifyQuotePush: a push built from the rows verifies', () => {
  const push = pushOf(ROWS, MARKETS);
  // Quotes in the batch's order: market B (id 1) first.
  assert.deepEqual(
    push.quotes.map((q) => q.market),
    [1, 3]
  );
  const res = verifyQuotePush({ ...push, rows: ROWS, references: REFS });
  assert.deepEqual(res.problems, []);
  assert.equal(res.ok, true);
  assert.equal(res.hash, push.commitment);
  assert.equal(res.json, CANONICAL);
});

test('verifyQuotePush: a tampered score, reading, time, commitment or market is caught', () => {
  const push = pushOf(ROWS, MARKETS);
  const tamper = (f: (q: QuoteIn) => QuoteIn) => verifyQuotePush({ quotes: push.quotes.map((q, i) => (i === 0 ? f(q) : q)), commitment: push.commitment, rows: ROWS, references: REFS });

  const score = tamper((q) => ({ ...q, scoreE2: q.scoreE2 + 1n }));
  assert.equal(score.ok, false);
  assert.match(score.problems.join('\n'), /score_e2 67308 is not toE2\(vi 673\.07\)/);

  const reading = tamper((q) => ({ ...q, readingE2: 1n }));
  assert.match(reading.problems.join('\n'), /reading_e2 1 is not toE2/);

  const time = tamper((q) => ({ ...q, printAt: q.printAt + 300 }));
  assert.match(time.problems.join('\n'), /print_at .* is not the row's time/);

  // read_at is the chain's clock, not committed: any value verifies.
  assert.equal(tamper((q) => ({ ...q, readAt: q.printAt - 1 })).ok, true);

  const wrongMarket = verifyQuotePush({ ...push, rows: ROWS, references: new Map([[3, REF_B], [1, REF_A]]) });
  assert.match(wrongMarket.problems.join('\n'), /belongs to market/);

  const otherCommitment = verifyQuotePush({ ...push, commitment: 'f'.repeat(64), rows: ROWS, references: REFS });
  assert.match(otherCommitment.problems.join('\n'), /the rows hash to .*, the push committed to f{64}/);
});

test('verifyQuotePush: a changed row (the database disagrees with the push) is caught', () => {
  const push = pushOf(ROWS, MARKETS);
  const edited = ROWS.map((r, i) => (i === 0 ? { ...r, vi: 455.52 } : r));
  const res = verifyQuotePush({ ...push, rows: edited, references: REFS });
  assert.equal(res.ok, false);
  assert.match(res.problems.join('\n'), /score_e2 45551 is not toE2\(vi 455\.52\)/);
  assert.match(res.problems.join('\n'), /the rows hash to/);
});

test('verifyQuotePush: missing rows, duplicates and an empty push', () => {
  const push = pushOf(ROWS, MARKETS);
  const missing = verifyQuotePush({ ...push, rows: [ROWS[0]] });
  assert.match(missing.problems.join('\n'), /print 901 \(market 1\) is not among the rows/);
  const dup = verifyQuotePush({ quotes: [push.quotes[0], push.quotes[0]], commitment: push.commitment, rows: ROWS });
  assert.match(dup.problems.join('\n'), /quoted more than once/);
  const empty = verifyQuotePush({ quotes: [], commitment: push.commitment, rows: ROWS });
  assert.match(empty.problems.join('\n'), /no quotes/);
  const badHex = verifyQuotePush({ ...push, commitment: 'XYZ', rows: ROWS });
  assert.match(badHex.problems.join('\n'), /not 64 lowercase hex/);
});
