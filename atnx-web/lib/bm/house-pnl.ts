// The house portfolio's PnL over time, worked out in the browser from the
// contract's views: the closed positions it keeps (history_of, the last 20)
// and the open ones, marked at the price they would close at now
// (markPosition in ./house-ticket.ts). There is no server-side series for
// the house, and the chain keeps no balance history, so this is the honest
// line the views allow: PnL, not portfolio value, and only over the closes
// the contract still holds.
//
// A position's PnL is what it paid back less its stake (payout − stake), as
// the portfolio's rows say it; the 1 % fee each order paid is not in it.
// All amounts are USDG units (6 decimals), as bigints, so the sums are exact.

import type { HouseClosed } from './house-types';

export interface PnlPoint {
  // Unix seconds.
  t: number;
  // The running PnL at `t`, in USDG units.
  pnl: bigint;
  // "start": 0 before the first of these trades opened; "close": a closed
  // position's PnL added; "now": the realised PnL plus what the open
  // positions would add if they closed now.
  kind: 'start' | 'close' | 'now';
  // The closed position behind a "close" point.
  id?: bigint;
}

// An open position as the series needs it: when it opened (null while its
// order is still confirming) and its PnL now (null when there is no price
// to value it at).
export interface OpenPnl {
  openedAt: number | null;
  pnl: bigint | null;
}

export interface PnlSeries {
  points: PnlPoint[];
  // The PnL of the closes the contract keeps, summed, and how many there are.
  realised: bigint;
  closes: number;
  // What the open positions with a price would add if they closed now.
  unrealised: bigint;
}

type Closed = Pick<HouseClosed, 'id' | 'stake' | 'payout' | 'openedAt' | 'closedAt'>;

// The running PnL: 0 when the first of these positions opened, a point at
// each close in the order they closed (the views list them newest first),
// and a last point now at the realised plus the unrealised PnL. Empty when
// there is nothing closed and nothing open.
export function pnlSeries(closed: readonly Closed[], open: readonly OpenPnl[], nowSecs: number): PnlSeries {
  const sorted = [...closed].sort((a, b) => a.closedAt - b.closedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unrealised = open.reduce((sum, p) => sum + (p.pnl ?? 0n), 0n);
  if (sorted.length === 0 && open.length === 0) return { points: [], realised: 0n, closes: 0, unrealised: 0n };

  const starts = [...sorted.map((c) => c.openedAt), ...open.flatMap((p) => (p.openedAt === null ? [] : [p.openedAt]))];
  const firstClose = sorted.length ? sorted[0].closedAt : nowSecs;
  const start = Math.min(starts.length ? Math.min(...starts) : nowSecs, firstClose, nowSecs);

  const points: PnlPoint[] = [{ t: start, pnl: 0n, kind: 'start' }];
  let running = 0n;
  for (const c of sorted) {
    running += c.payout - c.stake;
    points.push({ t: c.closedAt, pnl: running, kind: 'close', id: c.id });
  }
  // Now, never before the last close (a clock a little behind the chain's).
  const last = points[points.length - 1].t;
  points.push({ t: Math.max(nowSecs, last), pnl: running + unrealised, kind: 'now' });
  return { points, realised: running, closes: sorted.length, unrealised };
}
