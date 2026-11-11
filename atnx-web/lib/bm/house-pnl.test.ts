import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pnlSeries, type OpenPnl } from './house-pnl';

const USDG = 1_000_000n;
const NOW = 1_800_000_000;

// A closed position as history_of gives it, with only what the series reads.
const closed = (id: number, stake: bigint, payout: bigint, openedAt: number, closedAt: number) => ({ id: BigInt(id), stake, payout, openedAt, closedAt });
const brief = (s: ReturnType<typeof pnlSeries>) => s.points.map((p) => [p.kind, p.t, p.pnl]);

test('no closes and nothing open: nothing to plot', () => {
  const s = pnlSeries([], [], NOW);
  assert.deepEqual(s.points, []);
  assert.equal(s.realised, 0n);
  assert.equal(s.closes, 0);
  assert.equal(s.unrealised, 0n);
});

test('one close: 0 when it opened, its PnL when it closed, the same now', () => {
  const s = pnlSeries([closed(7, 20n * USDG, 19_973_908n, NOW - 600, NOW - 300)], [], NOW);
  assert.deepEqual(brief(s), [
    ['start', NOW - 600, 0n],
    ['close', NOW - 300, -26_092n],
    ['now', NOW, -26_092n],
  ]);
  assert.equal(s.points[1].id, 7n);
  assert.equal(s.realised, -26_092n);
  assert.equal(s.closes, 1);
});

test('losses run the line below zero; a liquidation pays nothing back', () => {
  const s = pnlSeries(
    [
      closed(1, 100n * USDG, 90n * USDG, NOW - 4000, NOW - 3000), // −10
      closed(2, 50n * USDG, 0n, NOW - 2900, NOW - 2000), // liquidated: −50
      closed(3, 20n * USDG, 35n * USDG, NOW - 1900, NOW - 1000), // +15
    ],
    [],
    NOW,
  );
  assert.deepEqual(
    s.points.map((p) => p.pnl),
    [0n, -10n * USDG, -60n * USDG, -45n * USDG, -45n * USDG],
  );
  assert.equal(s.realised, -45n * USDG);
  assert.equal(s.closes, 3);
});

test('open positions on top: the last point is realised plus unrealised, now', () => {
  const open: OpenPnl[] = [
    { openedAt: NOW - 500, pnl: 3n * USDG },
    { openedAt: NOW - 100, pnl: -1_250_000n },
    // Still confirming: no entry, no price, nothing to add.
    { openedAt: null, pnl: null },
  ];
  const s = pnlSeries([closed(4, 10n * USDG, 12n * USDG, NOW - 900, NOW - 800)], open, NOW);
  assert.deepEqual(brief(s), [
    ['start', NOW - 900, 0n],
    ['close', NOW - 800, 2n * USDG],
    ['now', NOW, 2n * USDG + 1_750_000n],
  ]);
  assert.equal(s.unrealised, 1_750_000n);
  assert.equal(s.realised, 2n * USDG);
});

test('only open positions: from when the first opened to now', () => {
  const s = pnlSeries([], [{ openedAt: NOW - 60, pnl: -10_000n }], NOW);
  assert.deepEqual(brief(s), [
    ['start', NOW - 60, 0n],
    ['now', NOW, -10_000n],
  ]);
  assert.equal(s.closes, 0);
});

test('closes arriving unsorted (newest first, as history_of lists them) are plotted in the order they closed', () => {
  const a = closed(10, 10n * USDG, 11n * USDG, NOW - 300, NOW - 250); // +1
  const b = closed(11, 10n * USDG, 8n * USDG, NOW - 200, NOW - 150); // −2
  const c = closed(12, 10n * USDG, 13n * USDG, NOW - 100, NOW - 50); // +3
  const s = pnlSeries([c, a, b], [], NOW);
  assert.deepEqual(
    s.points.map((p) => [p.kind, p.id ?? null, p.pnl]),
    [
      ['start', null, 0n],
      ['close', 10n, 1n * USDG],
      ['close', 11n, -1n * USDG],
      ['close', 12n, 2n * USDG],
      ['now', null, 2n * USDG],
    ],
  );
  // The start is the earliest open among them, not the first in the list.
  assert.equal(s.points[0].t, NOW - 300);
});

test('two closes in the same second keep the order of their ids', () => {
  const s = pnlSeries([closed(21, 10n * USDG, 9n * USDG, NOW - 90, NOW - 30), closed(20, 10n * USDG, 12n * USDG, NOW - 80, NOW - 30)], [], NOW);
  assert.deepEqual(
    s.points.filter((p) => p.kind === 'close').map((p) => [p.id, p.pnl]),
    [
      [20n, 2n * USDG],
      [21n, 1n * USDG],
    ],
  );
});

test('a clock behind the chain never puts "now" before the last close', () => {
  const s = pnlSeries([closed(1, 10n * USDG, 11n * USDG, NOW - 100, NOW + 5)], [], NOW);
  assert.equal(s.points[s.points.length - 1].t, NOW + 5);
});
