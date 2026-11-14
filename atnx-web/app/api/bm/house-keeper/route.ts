import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/cron';
import { houseEnabled } from '@/lib/bm/house-near';

// The house keeper's five-minute run: Vercel cron at 1-59/5 (vercel.json),
// a minute after the VI cron's boundary, so the slot's prints are written.
// One tick (lib/bm/house-keeper.ts, tickHouse): read each listed market's
// newest print, push the quotes with their commitment, crank what is due,
// list, close and settle markets. Does nothing unless
// BM_NEAR_HOUSE_ENABLED=1. `?dry=1` reports what it would do without
// sending or writing anything.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" https://near.atnx.app/api/bm/house-keeper?dry=1

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
    const { tickHouse } = await import('@/lib/bm/house-keeper');
    return NextResponse.json({ enabled: true, ...(await tickHouse({ dry })) });
  } catch (err) {
    console.error('[house keeper] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
