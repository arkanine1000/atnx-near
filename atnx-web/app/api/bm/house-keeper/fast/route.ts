import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/cron';
import { houseEnabled } from '@/lib/bm/house-near';

// The house keeper's every-minute run: Vercel cron at * * * * *
// (vercel.json). When an order or a close on the house contract is waiting
// for a quote, one transaction with those markets' quotes and the crank
// (lib/bm/house-keeper.ts, tickHouseFast); nothing when nothing waits, and
// nothing on the five-minute run's own minutes. It covers orders sent
// straight to the contract and quotes on demand that failed. Does nothing
// unless BM_NEAR_HOUSE_ENABLED=1. `?dry=1` reports what it would do without
// sending or writing anything.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" https://near.atnx.app/api/bm/house-keeper/fast?dry=1

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dry = new URL(request.url).searchParams.get('dry') === '1';
  if (!houseEnabled()) {
    return NextResponse.json({ enabled: false, dry, note: 'BM_NEAR_HOUSE_ENABLED is not 1; nothing ran' });
  }
  try {
    const { tickHouseFast } = await import('@/lib/bm/house-keeper');
    return NextResponse.json({ enabled: true, ...(await tickHouseFast({ dry })) });
  } catch (err) {
    console.error('[house keeper fast] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
